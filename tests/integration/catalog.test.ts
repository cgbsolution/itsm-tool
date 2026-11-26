/**
 * Service catalog against a real PostgreSQL database (TEST_DATABASE_URL, default:
 * the dev compose database `itsm_test`). Each run creates its own tenant.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://itsm:itsm_dev_password@localhost:5544/itsm_test"

const { pool, q1, q, exec } = await import("@/lib/db")
const { migrate } = await import("@/lib/db/migrate")
const { createTenant } = await import("@/lib/tenants")
const { actorForUser } = await import("@/lib/auth/session")
const catalog = await import("@/lib/catalog/service")
const { browseCatalog, getCatalogItem } = await import("@/lib/catalog/queries")
const { decideApproval, myPendingApprovals } = await import("@/lib/itsm/approvals")

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
const groups: Record<string, string> = {}

async function user(key: string, role: string) {
  const row = await q1<{ id: string }>(
    "insert into users (tenant_id, email, full_name, role) values ($1, $2, $3, $4) returning id",
    [tenantId, `${key}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@catalog.test`, key, role]
  )
  ids[key] = row!.id
}

async function group(key: string, kind: string, members: string[]) {
  const g = await q1<{ id: string }>("insert into groups (tenant_id, name, kind) values ($1, $2, $3) returning id", [tenantId, `${key} ${Date.now()}`, kind])
  groups[key] = g!.id
  for (const m of members) await exec("insert into group_members (group_id, user_id) values ($1, $2)", [g!.id, ids[m]])
}

async function refresh() {
  for (const k of Object.keys(ids)) actors[k] = (await actorForUser(ids[k], "test"))!
}

const laptopForm = [
  { key: "for_person", label: "Who is it for?", type: "text", required: true },
  { key: "model", label: "Model", type: "select", options: "Standard\nPerformance", required: true },
  { key: "needed_by", label: "Needed by", type: "date", required: true },
  { key: "extras", label: "Accessories", type: "multiselect", options: "Mouse\nDock" },
  { key: "policy", label: "I accept the policy", type: "checkbox", required: true },
]

async function makeItem(overrides: Partial<Parameters<typeof catalog.createCatalogItem>[1]> = {}) {
  return catalog.createCatalogItem(actors.admin, {
    name: `Laptop ${Math.random().toString(36).slice(2, 6)}`,
    isActive: true,
    visibility: "all",
    defaultPriority: "high",
    requiresApproval: false,
    approvalMode: "any",
    approveByManager: false,
    ...overrides,
  })
}

const goodAnswers = { for_person: ["Meera"], model: ["Standard"], needed_by: ["2026-12-15"], extras: ["Dock", "Mouse"], policy: ["on"] }

describe.skipIf(!reachable)("service catalog (integration)", () => {
  beforeAll(async () => {
    await migrate()
    tenantId = await createTenant(`Catalog Test ${Date.now()}`, { timezone: "UTC", slaProfile: "legacy" })
    await user("admin", "admin")
    await user("asha", "engineer")
    await user("ravi", "engineer")
    await user("boss", "user")
    await user("meera", "user")
    await user("john", "user")
    await exec("update users set manager_id = $2 where id = $1", [ids.meera, ids.boss])
    await group("fulfil", "support", ["asha"])
    await group("approvers", "approvers", ["ravi", "asha"])
    await group("all_approvers", "approvers", ["ravi", "asha", "meera"])
    await group("empty", "approvers", [])
    await refresh()
  })
  afterAll(async () => {
    await pool().end()
  })

  it("only lets catalog managers change the catalog, and audits changes", async () => {
    await expect(
      catalog.createCatalogItem(actors.meera, { name: "Nope", isActive: true, visibility: "all", defaultPriority: "low", requiresApproval: false, approvalMode: "any", approveByManager: false })
    ).rejects.toThrow(/catalog managers/)
    await expect(catalog.createCatalogItem(actors.admin, { name: "Bad", isActive: true, visibility: "all", defaultPriority: "low", requiresApproval: true, approvalMode: "any", approveByManager: false })).rejects.toThrow(/needs an approver/)
    const cat = await catalog.createCatalogCategory(actors.admin, { name: "Hardware" })
    await expect(catalog.createCatalogCategory(actors.admin, { name: "hardware" })).rejects.toThrow(/already exists/)
    const id = await makeItem({ categoryId: cat })
    await expect(catalog.setCatalogItemForm(actors.admin, id, [{ key: "Bad Key", label: "X", type: "text" }])).rejects.toThrow(/lower-case/)
    await expect(catalog.setCatalogItemForm(actors.admin, id, [{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }])).rejects.toThrow(/used twice/)
    expect(await catalog.setCatalogItemForm(actors.admin, id, laptopForm)).toBe(5)
    const logged = await q<{ action: string }>("select action from audit_log where tenant_id = $1 and action like 'catalog.%' order by id", [tenantId])
    expect(logged.map((l) => l.action)).toEqual(expect.arrayContaining(["catalog.category_created", "catalog.item_created", "catalog.item_form_updated"]))
  })

  it("creates the starter items once", async () => {
    const first = await catalog.createStarterItems(actors.admin)
    expect(first.created).toEqual(["New laptop", "Software installation", "VPN access", "Shared mailbox access"])
    const again = await catalog.createStarterItems(actors.admin)
    expect(again.created).toEqual([])
    expect(again.skipped).toHaveLength(4)
    const sections = await browseCatalog(actors.meera)
    const names = sections.flatMap((s) => s.items.map((i) => i.name))
    expect(names).toEqual(expect.arrayContaining(["New laptop", "VPN access"]))
    expect(sections.map((s) => s.name)).toEqual(expect.arrayContaining(["Hardware", "Software", "Access"]))
  })

  it("raises a request with manager then group approval, routing and tasks", async () => {
    const id = await makeItem({ requiresApproval: true, approveByManager: true, approverGroupId: groups.approvers, approvalMode: "any", fulfilmentGroupId: groups.fulfil })
    await catalog.setCatalogItemForm(actors.admin, id, laptopForm)
    await catalog.setCatalogItemTasks(actors.admin, id, "Order device\nImage device")

    await expect(catalog.submitRequest(actors.meera, id, { model: ["Gaming"], needed_by: ["2026-02-31"] })).rejects.toThrow(
      /Please check 4 fields: Who is it for\? is required; Model: "Gaming" is not one of the options; Needed by must be a valid date/
    )

    const t = await catalog.submitRequest(actors.meera, id, goodAnswers)
    expect(t.ticket_type).toBe("service_request")
    expect(t.status).toBe("pending_approval")
    expect(t.subject).toMatch(/^Laptop \w+ – Meera$/)
    expect(t.requester_id).toBe(ids.meera)
    expect(t.priority).toBe("high")
    expect(t.catalog_item_id).toBe(id)
    expect(t.assignment_group_id).toBe(groups.fulfil)
    expect(t.form_data).toEqual({ for_person: "Meera", model: "Standard", needed_by: "2026-12-15", extras: ["Mouse", "Dock"], policy: true })
    expect(t.description).toContain("Accessories: Mouse, Dock")
    const tasks = await q<{ title: string }>("select title from ticket_tasks where ticket_id = $1 order by sort_order", [t.id])
    expect(tasks.map((x) => x.title)).toEqual(["Order device", "Image device"])
    const approvals = await q<{ step: number; approver_id: string | null; group_id: string | null }>("select step, approver_id, group_id from approvals where ticket_id = $1 order by step", [t.id])
    expect(approvals).toEqual([
      { step: 1, approver_id: ids.boss, group_id: null },
      { step: 2, approver_id: null, group_id: groups.approvers },
    ])

    // step 2 waits for step 1; the requester never sees their own approval
    expect((await myPendingApprovals(actors.ravi)).find((a) => a.ticket_id === t.id)).toBeUndefined()
    expect((await myPendingApprovals(actors.meera)).find((a) => a.ticket_id === t.id)).toBeUndefined()
    const mine = (await myPendingApprovals(actors.boss)).find((a) => a.ticket_id === t.id)
    expect(mine).toBeTruthy()
    await decideApproval(actors.boss, mine!.id, true, null)
    const forRavi = (await myPendingApprovals(actors.ravi)).find((a) => a.ticket_id === t.id)
    expect(forRavi).toBeTruthy()
    await decideApproval(actors.ravi, forRavi!.id, true, "OK")
    expect((await q1<{ status: string }>("select status from tickets where id = $1", [t.id]))!.status).toBe("approved")
  })

  it("uses every member except the requester for 'all' approval, and rejection ends the request", async () => {
    const id = await makeItem({ requiresApproval: true, approverGroupId: groups.all_approvers, approvalMode: "all" })
    const t = await catalog.submitRequest(actors.meera, id, {})
    expect(t.status).toBe("pending_approval")
    const rows = await q<{ approver_id: string }>("select approver_id from approvals where ticket_id = $1 and status = 'pending'", [t.id])
    expect(rows.map((r) => r.approver_id).sort()).toEqual([ids.asha, ids.ravi].sort())
    const a = (await myPendingApprovals(actors.asha)).find((x) => x.ticket_id === t.id)!
    await decideApproval(actors.asha, a.id, true, null)
    expect((await q1<{ status: string }>("select status from tickets where id = $1", [t.id]))!.status).toBe("pending_approval")
    const r = (await myPendingApprovals(actors.ravi)).find((x) => x.ticket_id === t.id)!
    await decideApproval(actors.ravi, r.id, false, "Not in budget")
    expect((await q1<{ status: string }>("select status from tickets where id = $1", [t.id]))!.status).toBe("rejected")
  })

  it("skips approval when nobody can approve, with an internal note", async () => {
    const id = await makeItem({ requiresApproval: true, approveByManager: true, approverGroupId: groups.empty })
    const t = await catalog.submitRequest(actors.john, id, {}) // john has no manager; the group is empty
    expect(t.status).toBe("new")
    expect(await q1("select 1 from approvals where ticket_id = $1", [t.id])).toBeNull()
    const note = await q1<{ is_internal: boolean; body: string }>("select is_internal, body from ticket_comments where ticket_id = $1", [t.id])
    expect(note?.is_internal).toBe(true)
    expect(note?.body).toMatch(/nobody could approve/)

    const plain = await makeItem({ requiresApproval: false })
    expect((await catalog.submitRequest(actors.john, plain, {})).status).toBe("new")
  })

  it("hides inactive, staff-only and other tenants' items", async () => {
    const staffOnly = await makeItem({ visibility: "staff" })
    await expect(catalog.submitRequest(actors.meera, staffOnly, {})).rejects.toThrow(/does not exist/)
    await expect(getCatalogItem(actors.meera, staffOnly)).rejects.toThrow(/not found/)
    expect((await catalog.submitRequest(actors.asha, staffOnly, {})).status).toBe("new")

    const inactive = await makeItem({ isActive: false })
    await expect(catalog.submitRequest(actors.asha, inactive, {})).rejects.toThrow(/does not exist/)
    expect((await getCatalogItem(actors.admin, inactive)).preview).toBe(true)

    const otherTenant = await createTenant(`Catalog Other ${Date.now()}`, { timezone: "UTC" })
    const stranger = await q1<{ id: string }>("insert into users (tenant_id, email, full_name, role) values ($1, $2, 'x', 'admin') returning id", [otherTenant, `x.${Date.now()}@other.test`])
    const outsider = (await actorForUser(stranger!.id, "test"))!
    const mine = await makeItem({})
    await expect(catalog.submitRequest(outsider, mine, {})).rejects.toThrow(/does not exist/)
    await expect(catalog.updateCatalogItem(outsider, mine, { name: "Hijack", isActive: true, visibility: "all", defaultPriority: "low", requiresApproval: false, approvalMode: "any", approveByManager: false })).rejects.toThrow(/not found/)
    await expect(catalog.deleteCatalogItem(outsider, mine)).rejects.toThrow(/not found/)
  })
})
