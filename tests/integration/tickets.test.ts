/**
 * End-to-end service tests against a real PostgreSQL database
 * (TEST_DATABASE_URL, default: the dev compose database `itsm_test`).
 * Each run creates its own tenant, so it can run repeatedly.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://itsm:itsm_dev_password@localhost:5544/itsm_test"

const { pool, q1, q, exec } = await import("@/lib/db")
const { migrate } = await import("@/lib/db/migrate")
const { createTenant } = await import("@/lib/tenants")
const { actorForUser } = await import("@/lib/auth/session")
const tickets = await import("@/lib/itsm/tickets")
const { decideApproval, myPendingApprovals } = await import("@/lib/itsm/approvals")
const { runSlaCheck } = await import("@/lib/itsm/sla-jobs")
const { verifyAuditChain } = await import("@/lib/audit")
const { listTickets } = await import("@/lib/itsm/queries")

let reachable = true
try {
  await pool().query("select 1")
} catch {
  reachable = false
}

type A = NonNullable<Awaited<ReturnType<typeof actorForUser>>>
let tenantId = ""
const ids: Record<string, string> = {}
const actors: Record<string, A> = {}

async function user(key: string, role: string) {
  const row = await q1<{ id: string }>(
    "insert into users (tenant_id, email, full_name, role) values ($1, $2, $3, $4) returning id",
    [tenantId, `${key}.${Date.now()}@it.test`, key, role]
  )
  ids[key] = row!.id
}

async function refresh() {
  for (const k of Object.keys(ids)) actors[k] = (await actorForUser(ids[k], "test"))!
}

describe.skipIf(!reachable)("ticket service (integration)", () => {
  beforeAll(async () => {
    await migrate()
    tenantId = await createTenant(`IT Test ${Date.now()}`, { timezone: "UTC", slaProfile: "legacy" })
    await user("admin", "admin")
    await user("asha", "engineer")
    await user("ravi", "engineer")
    await user("meera", "user")
    await user("john", "user")
    const cab = await q1<{ id: string }>("select id from groups where tenant_id = $1 and kind = 'cab'", [tenantId])
    await exec("insert into group_members (group_id, user_id) values ($1, $2), ($1, $3)", [cab!.id, ids.ravi, ids.admin])
    await refresh()
  })
  afterAll(async () => {
    await pool().end()
  })

  it("runs an incident through its lifecycle with SLA pause/resume", async () => {
    const t = await tickets.createTicket(actors.meera, { type: "incident", subject: "Printer offline", impact: "low", urgency: "high" })
    expect(t.number).toMatch(/^INC\d{7}$/)
    expect(t.status).toBe("new")
    expect(t.priority).toBe("medium") // low × high
    expect(t.sla_resolution_due).not.toBeNull()

    // requester cannot raise a problem
    await expect(tickets.createTicket(actors.meera, { type: "problem", subject: "nope" })).rejects.toThrow()

    const acquired = await tickets.acquireTicket(actors.asha, t.id)
    expect(acquired.assignee_id).toBe(ids.asha)
    expect(acquired.status).toBe("in_progress")
    expect(acquired.first_response_at).not.toBeNull()

    // strict assignment: another engineer may only add internal notes
    await expect(tickets.transitionTicket(actors.ravi, t.id, "resolve", { resolutionCode: "x", resolutionNotes: "y" })).rejects.toThrow()
    await tickets.addComment(actors.ravi, t.id, { body: "Seen this before", internal: true })

    const held = await tickets.transitionTicket(actors.asha, t.id, "hold", { holdReason: "Awaiting requester", holdHours: 4 })
    expect(held.status).toBe("on_hold")
    const paused = await q1<{ status: string }>("select status from ticket_sla where ticket_id = $1 and kind = 'resolution'", [t.id])
    expect(paused?.status).toBe("paused")

    // a requester reply resumes the ticket
    await tickets.addComment(actors.meera, t.id, { body: "Here is the info" })
    const after = await q1<{ status: string }>("select status from tickets where id = $1", [t.id])
    expect(after?.status).toBe("in_progress")

    await expect(tickets.transitionTicket(actors.asha, t.id, "resolve", {})).rejects.toThrow(/resolution/i)
    const resolved = await tickets.transitionTicket(actors.asha, t.id, "resolve", { resolutionCode: "Solved (permanently)", resolutionNotes: "Replaced toner" })
    expect(resolved.status).toBe("resolved")

    const reopened = await tickets.transitionTicket(actors.meera, t.id, "reopen", { comment: "Still broken" })
    expect(reopened.status).toBe("in_progress")
    await tickets.transitionTicket(actors.asha, t.id, "resolve", { resolutionCode: "Solved (permanently)", resolutionNotes: "Driver fixed" })
    const closed = await tickets.transitionTicket(actors.meera, t.id, "close", {})
    expect(closed.status).toBe("closed")
    const clocks = await q<{ kind: string; status: string }>("select kind, status from ticket_sla where ticket_id = $1 order by kind", [t.id])
    expect(clocks.map((c) => c.status)).toEqual(["met", "met"])

    // internal notes are hidden from the requester's list of comments
    const others = await listTickets(actors.john, {})
    expect(others.rows.find((r) => r.id === t.id)).toBeUndefined()
    const notified = await q1<{ n: number }>("select count(*) as n from email_outbox where related_id = $1", [t.id])
    expect(notified!.n).toBeGreaterThan(0)
  })

  it("refuses stale edits (optimistic concurrency)", async () => {
    const t = await tickets.createTicket(actors.asha, { type: "incident", subject: "Concurrency", assigneeId: ids.asha })
    await tickets.updateTicket(actors.asha, t.id, t.version, { subject: "Concurrency v2" })
    await expect(tickets.updateTicket(actors.asha, t.id, t.version, { subject: "stale" })).rejects.toThrow(/changed/)
  })

  it("takes a change through CAB approval with segregation of duties", async () => {
    const c = await tickets.createTicket(actors.asha, { type: "change", subject: "Upgrade core switch firmware", changeType: "normal", risk: "medium", assigneeId: ids.asha })
    expect(c.number).toMatch(/^CHG/)
    expect(c.status).toBe("draft")
    await expect(tickets.transitionTicket(actors.asha, c.id, "submit", {})).rejects.toThrow(/implementation plan/i)
    const start = new Date(Date.now() + 86_400_000)
    const v = (await q1<{ version: number }>("select version from tickets where id = $1", [c.id]))!.version
    await tickets.updateTicket(actors.asha, c.id, v, {
      implementationPlan: "1. Backup config 2. Upload firmware 3. Reboot",
      backoutPlan: "Boot the previous image",
      plannedStart: start,
      plannedEnd: new Date(start.getTime() + 3_600_000),
    })
    await tickets.transitionTicket(actors.asha, c.id, "submit", {})
    const pending = await tickets.transitionTicket(actors.asha, c.id, "request_approval", {})
    expect(pending.status).toBe("pending_approval")

    const forRavi = await myPendingApprovals(actors.ravi)
    const approval = forRavi.find((a) => a.ticket_id === c.id)
    expect(approval).toBeTruthy()
    // the change owner never sees or decides their own approval
    expect((await myPendingApprovals(actors.asha)).find((a) => a.ticket_id === c.id)).toBeUndefined()
    await expect(decideApproval(actors.ravi, approval!.id, false, null)).rejects.toThrow(/reason/i)
    await decideApproval(actors.ravi, approval!.id, true, "Looks fine")
    const scheduled = await q1<{ status: string }>("select status from tickets where id = $1", [c.id])
    expect(scheduled?.status).toBe("scheduled")

    await tickets.transitionTicket(actors.asha, c.id, "implement", {})
    await expect(tickets.transitionTicket(actors.asha, c.id, "complete", {})).rejects.toThrow(/outcome/i)
    await tickets.transitionTicket(actors.asha, c.id, "complete", { outcome: "successful" })
    const done = await tickets.transitionTicket(actors.asha, c.id, "close", {})
    expect(done.status).toBe("closed")
  })

  it("blocks changes that overlap a change freeze", async () => {
    const start = new Date(Date.now() + 2 * 86_400_000)
    await exec(
      "insert into maintenance_windows (tenant_id, name, kind, applies_to, starts_at, ends_at) values ($1, 'Year-end freeze', 'blackout', 'changes', $2, $3)",
      [tenantId, new Date(start.getTime() - 3_600_000), new Date(start.getTime() + 3_600_000)]
    )
    const c = await tickets.createTicket(actors.asha, {
      type: "change", subject: "Freeze test", changeType: "normal", implementationPlan: "x", backoutPlan: "y",
      plannedStart: start, plannedEnd: new Date(start.getTime() + 1_800_000), assigneeId: ids.asha,
    })
    await expect(tickets.transitionTicket(actors.asha, c.id, "submit", {})).rejects.toThrow(/freeze/i)
  })

  it("escalates SLA breaches and ends holds automatically", async () => {
    const t = await tickets.createTicket(actors.meera, { type: "incident", subject: "SLA breach test" })
    await exec("update ticket_sla set due_at = now() - interval '1 minute', started_at = now() - interval '2 hours' where ticket_id = $1", [t.id])
    await runSlaCheck()
    const row = await q1<{ sla_resolution_breached: boolean; sla_response_breached: boolean }>("select sla_resolution_breached, sla_response_breached from tickets where id = $1", [t.id])
    expect(row?.sla_resolution_breached).toBe(true)
    const note = await q1<{ n: number }>("select count(*) as n from notifications where entity_id = $1 and kind = 'sla.breach'", [t.id])
    expect(note!.n).toBeGreaterThan(0)

    const h = await tickets.createTicket(actors.asha, { type: "incident", subject: "Hold expiry", assigneeId: ids.asha })
    await tickets.transitionTicket(actors.asha, h.id, "start", {})
    await tickets.transitionTicket(actors.asha, h.id, "hold", { holdReason: "Awaiting vendor", holdHours: 1 })
    await exec("update tickets set hold_until = now() - interval '1 minute' where id = $1", [h.id])
    await runSlaCheck()
    expect((await q1<{ status: string }>("select status from tickets where id = $1", [h.id]))?.status).toBe("in_progress")
  })

  it("keeps the audit log intact and append-only", async () => {
    await expect(exec("delete from audit_log")).rejects.toThrow(/append-only/)
    const r = await verifyAuditChain()
    expect(r.brokenAt).toBeNull()
  })
})
