import { describe, expect, it } from "vitest"
import { availableTransitions, WORKFLOWS, TYPE_STATUSES, legacyStatus } from "@/lib/itsm/workflow"
import { ticketAccess, type AccessActor, type AccessTicket } from "@/lib/itsm/access"
import { permissionsFor } from "@/lib/auth/permissions"
import { occurrences, overlapsBlackout, type WindowRow } from "@/lib/itsm/windows"

describe("workflows", () => {
  it("only moves between statuses of the same type", () => {
    for (const [type, transitions] of Object.entries(WORKFLOWS)) {
      const allowed = new Set(TYPE_STATUSES[type as keyof typeof TYPE_STATUSES])
      for (const t of transitions) {
        expect(allowed.has(t.to), `${type}.${t.action} → ${t.to}`).toBe(true)
        for (const f of t.from) expect(allowed.has(f), `${type}.${t.action} from ${f}`).toBe(true)
      }
    }
  })
  it("gives changes their own lifecycle with approval", () => {
    const fromAssessment = availableTransitions("change", "assessment", ["worker"]).map((t) => t.action)
    expect(fromAssessment).toContain("request_approval")
    expect(availableTransitions("change", "pending_approval", ["worker"]).map((t) => t.action)).not.toContain("approve_system")
    expect(availableTransitions("change", "pending_approval", ["system"]).map((t) => t.action)).toContain("approve_system")
  })
  it("maps legacy statuses", () => {
    expect(legacyStatus("open")).toBe("in_progress")
    expect(legacyStatus("hold")).toBe("on_hold")
    expect(legacyStatus("closed")).toBe("closed")
    expect(legacyStatus(null)).toBe("new")
  })
})

const tenant = "t1"
const ticket = (over: Partial<AccessTicket> = {}): AccessTicket => ({
  tenant_id: tenant, ticket_type: "incident", status: "in_progress", requester_id: "req", created_by: "req",
  assignee_id: "eng1", assignment_group_id: "g1", resolved_at: null, ...over,
})
const actor = (id: string, role: string, over: Partial<AccessActor> = {}): AccessActor => ({
  id, tenantId: tenant, permissions: permissionsFor(role), groupIds: [], strictAssignment: true, ...over,
})

describe("ticket access (ported legacy rules)", () => {
  it("lets only the assignee work a ticket under strict assignment", () => {
    expect(ticketAccess(actor("eng1", "engineer"), ticket()).canWork).toBe(true)
    const other = ticketAccess(actor("eng2", "engineer"), ticket())
    expect(other.canView).toBe(true)
    expect(other.canWork).toBe(false)
    expect(other.canCommentInternal).toBe(true)
    expect(ticketAccess(actor("adm", "admin"), ticket()).canWork).toBe(true)
  })
  it("lets any engineer work when strict assignment is off", () => {
    expect(ticketAccess(actor("eng2", "engineer", { strictAssignment: false }), ticket()).canWork).toBe(true)
  })
  it("hides other people's tickets from requesters and other tenants", () => {
    expect(ticketAccess(actor("someone", "user"), ticket()).canView).toBe(false)
    expect(ticketAccess({ ...actor("adm", "admin"), tenantId: "t2" }, ticket()).canView).toBe(false)
  })
  it("lets the requester reopen only inside the window, and cancel only while new", () => {
    const now = new Date("2026-11-27T00:00:00Z")
    const resolved = ticket({ status: "resolved", resolved_at: new Date("2026-11-25T00:00:00Z") })
    const r = ticketAccess(actor("req", "user"), resolved, { reopenWindowDays: 7, now }).transitions.map((t) => t.action)
    expect(r).toEqual(expect.arrayContaining(["reopen", "close"]))
    const late = ticketAccess(actor("req", "user"), { ...resolved, resolved_at: new Date("2026-11-01T00:00:00Z") }, { reopenWindowDays: 7, now })
    expect(late.transitions.map((t) => t.action)).not.toContain("reopen")
    expect(ticketAccess(actor("req", "user"), ticket({ status: "in_progress" })).transitions.map((t) => t.action)).not.toContain("cancel")
    expect(ticketAccess(actor("req", "user"), ticket({ status: "new", assignee_id: null })).transitions.map((t) => t.action)).toContain("cancel")
  })
  it("requires problem/change permissions for those types", () => {
    const custom = { ...actor("eng1", "custom"), permissions: permissionsFor("custom", ["ticket.view_all", "ticket.work"]) }
    expect(ticketAccess(custom, ticket({ ticket_type: "change" })).canWork).toBe(false)
  })
})

describe("maintenance windows", () => {
  const w = (over: Partial<WindowRow>): WindowRow => ({
    id: "w", name: "Freeze", description: null, kind: "blackout", applies_to: "all",
    starts_at: new Date("2026-12-01T00:00:00Z"), ends_at: new Date("2026-12-01T06:00:00Z"),
    recurrence: "none", recurrence_until: null, is_active: true, ...over,
  })
  it("expands weekly recurrence", () => {
    const occ = occurrences(w({ recurrence: "weekly" }), new Date("2026-12-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"))
    expect(occ.map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"])
  })
  it("detects overlap with a freeze", () => {
    expect(overlapsBlackout([w({})], new Date("2026-12-01T05:00:00Z"), new Date("2026-12-01T07:00:00Z"))?.name).toBe("Freeze")
    expect(overlapsBlackout([w({})], new Date("2026-12-01T06:00:00Z"), new Date("2026-12-01T07:00:00Z"))).toBeNull()
  })
})
