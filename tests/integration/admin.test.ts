/**
 * Administration services against a real PostgreSQL database
 * (TEST_DATABASE_URL, default: the dev compose database `itsm_test`).
 * Each run creates its own tenant, so it can run repeatedly.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://itsm:itsm_dev_password@localhost:5544/itsm_test"

const { pool, q1, q, exec } = await import("@/lib/db")
const { migrate } = await import("@/lib/db/migrate")
const { createTenant } = await import("@/lib/tenants")
const { actorForUser } = await import("@/lib/auth/session")
const users = await import("@/lib/admin/users")
const roles = await import("@/lib/admin/roles")
const groups = await import("@/lib/admin/groups")
const orgs = await import("@/lib/admin/organizations")
const itsm = await import("@/lib/admin/itsm")
const sla = await import("@/lib/admin/sla")
const fields = await import("@/lib/admin/fields")
const templates = await import("@/lib/admin/templates")
const windows = await import("@/lib/admin/windows")
const { createTicket } = await import("@/lib/itsm/tickets")
const { loadTenantSettings } = await import("@/lib/itsm/config")

let reachable = true
try {
  await pool().query("select 1")
} catch {
  reachable = false
}

type A = NonNullable<Awaited<ReturnType<typeof actorForUser>>>
const stamp = Date.now()
let tenantId = ""
const ids: Record<string, string> = {}
const actors: Record<string, A> = {}

async function seedUser(key: string, role: string) {
  const row = await q1<{ id: string }>("insert into users (tenant_id, email, full_name, role) values ($1, $2, $3, $4) returning id", [
    tenantId,
    `${key}.${stamp}@admin.test`,
    key,
    role,
  ])
  ids[key] = row!.id
  actors[key] = (await actorForUser(row!.id, `session-${key}`))!
}

async function addSession(userId: string) {
  await exec("insert into sessions (id, user_id, expires_at) values ($1, $2, now() + interval '1 hour')", [`s-${userId}-${Math.random()}`, userId])
}

async function sessionCount(userId: string) {
  return (await q1<{ n: number }>("select count(*) as n from sessions where user_id = $1", [userId]))!.n
}

async function lastAudit(entityId: string) {
  return q1<{ action: string; data: Record<string, unknown> | null; summary: string }>(
    "select action, data, summary from audit_log where tenant_id = $1 and entity_id = $2 order by id desc limit 1",
    [tenantId, entityId]
  )
}

describe.skipIf(!reachable)("administration services (integration)", () => {
  beforeAll(async () => {
    await migrate()
    tenantId = await createTenant(`Admin Test ${stamp}`, { timezone: "UTC" })
    await seedUser("admin", "admin")
    await seedUser("root", "superadmin")
  })
  afterAll(async () => {
    await pool().end()
  })

  it("creates users with a temporary password or an invitation", async () => {
    const email = `Meera.${stamp}@Admin.Test`
    await expect(users.createUser(actors.admin, { email, fullName: "Meera", role: "user", mode: "password", password: "short" })).rejects.toThrow(/Temporary password/)
    const pw = await users.createUser(actors.admin, { email, fullName: "Meera", role: "user", mode: "password", password: "Blue-Kettle-42" })
    expect(pw.invited).toBe(false)
    const row = await q1<{ email: string; status: string; must_change_password: boolean; password_hash: string | null }>(
      "select email, status, must_change_password, password_hash from users where id = $1",
      [pw.id]
    )
    expect(row).toMatchObject({ email: email.toLowerCase(), status: "active", must_change_password: true })
    expect(row!.password_hash).toMatch(/^\$2/)
    const a = await lastAudit(pw.id)
    expect(a?.action).toBe("admin.user_created")
    expect(JSON.stringify(a)).not.toMatch(/Blue-Kettle|\$2[aby]\$/)
    ids.meera = pw.id

    // e-mail addresses are unique regardless of case
    await expect(users.createUser(actors.admin, { email: email.toUpperCase(), fullName: "Dup", role: "user", mode: "invite" })).rejects.toThrow(/already exists/)

    const inv = await users.createUser(actors.admin, { email: `ravi.${stamp}@admin.test`, fullName: "Ravi", role: "engineer", mode: "invite" })
    expect(inv.invited).toBe(true)
    const invited = await q1<{ status: string; password_hash: string | null }>("select status, password_hash from users where id = $1", [inv.id])
    expect(invited).toEqual({ status: "invited", password_hash: null })
    const token = await q1<{ purpose: string; hours: number }>(
      "select purpose, round(extract(epoch from expires_at - created_at) / 3600) as hours from auth_tokens where user_id = $1",
      [inv.id]
    )
    expect(token).toEqual({ purpose: "invite", hours: 72 })
    const mail = await q1<{ to_address: string; subject: string; body_text: string }>("select to_address, subject, body_text from email_outbox where related_id = $1", [inv.id])
    expect(mail?.to_address).toBe(`ravi.${stamp}@admin.test`)
    expect(mail?.body_text).toMatch(/Hello Ravi/)
    expect(mail?.body_text).toMatch(/\/reset\/[\w-]{20,}/)
    ids.ravi = inv.id

    // invited accounts get a fresh invitation, active ones a reset link
    expect((await users.sendPasswordLink(actors.admin, inv.id)).purpose).toBe("invite")
    const reset = await users.sendPasswordLink(actors.admin, pw.id)
    expect(reset.purpose).toBe("reset")
    // no SMTP in the test environment: the link is handed to the admin instead
    if (reset.link) expect(reset.link).toMatch(/\/reset\/[A-Za-z0-9_-]{40,}$/)
  })

  it("changes roles (signing the person out) and refuses changing your own", async () => {
    await addSession(ids.meera)
    await addSession(ids.meera)
    expect(await sessionCount(ids.meera)).toBe(2)
    expect(await users.setUserRole(actors.admin, ids.meera, "engineer")).toBe(true)
    expect(await sessionCount(ids.meera)).toBe(0)
    const a = await lastAudit(ids.meera)
    expect(a?.action).toBe("admin.user_role_changed")
    expect(a?.data).toMatchObject({ from: "user", to: "engineer", sessions_revoked: 2 })
    expect(await users.setUserRole(actors.admin, ids.meera, "engineer")).toBe(false)
    await expect(users.setUserRole(actors.admin, ids.admin, "user")).rejects.toThrow(/your own role/)
    await expect(users.setUserRole(actors.admin, ids.meera, "no_such_role")).rejects.toThrow(/Choose a role/)
  })

  it("keeps the super administrator role to super administrators", async () => {
    await expect(users.setUserRole(actors.admin, ids.meera, "superadmin")).rejects.toThrow(/super administrator/)
    await expect(users.setUserEnabled(actors.admin, ids.root, false)).rejects.toThrow(/super administrator/)
    await expect(users.updateUserDetails(actors.admin, ids.root, { fullName: "x", email: `evil.${stamp}@admin.test` })).rejects.toThrow(/super administrator/)
    await expect(users.createUser(actors.admin, { email: `sa.${stamp}@admin.test`, fullName: "SA", role: "superadmin", mode: "invite" })).rejects.toThrow(/super administrator/)
    // a super admin can
    expect(await users.setUserRole(actors.root, ids.ravi, "superadmin")).toBe(true)
    expect(await users.setUserRole(actors.root, ids.ravi, "engineer")).toBe(true)
  })

  it("disables (signing out) and re-enables accounts, never your own", async () => {
    await addSession(ids.meera)
    expect(await users.setUserEnabled(actors.admin, ids.meera, false)).toBe(true)
    expect(await sessionCount(ids.meera)).toBe(0)
    expect((await q1<{ status: string }>("select status from users where id = $1", [ids.meera]))!.status).toBe("disabled")
    expect(await actorForUser(ids.meera, "x")).toBeNull()
    expect((await lastAudit(ids.meera))?.action).toBe("admin.user_disabled")
    await expect(users.sendPasswordLink(actors.admin, ids.meera)).rejects.toThrow(/Enable the account/)
    expect(await users.setUserEnabled(actors.admin, ids.meera, true)).toBe(true)
    expect((await q1<{ status: string }>("select status from users where id = $1", [ids.meera]))!.status).toBe("active")
    await expect(users.setUserEnabled(actors.admin, ids.admin, false)).rejects.toThrow(/your own account/)
  })

  it("unlocks, resets two-step sign-in, signs out everywhere and edits details", async () => {
    await exec("update users set failed_logins = 5, locked_until = now() + interval '1 hour', mfa_enabled = true, mfa_secret_enc = 'v1.x.y.z' where id = $1", [ids.meera])
    expect(await users.unlockUser(actors.admin, ids.meera)).toBe(true)
    expect(await users.unlockUser(actors.admin, ids.meera)).toBe(false)
    expect(await users.resetUserMfa(actors.admin, ids.meera)).toBe(true)
    const u = await q1<{ failed_logins: number; locked_until: Date | null; mfa_enabled: boolean; mfa_secret_enc: string | null }>(
      "select failed_logins, locked_until, mfa_enabled, mfa_secret_enc from users where id = $1",
      [ids.meera]
    )
    expect(u).toEqual({ failed_logins: 0, locked_until: null, mfa_enabled: false, mfa_secret_enc: null })
    await expect(users.resetUserMfa(actors.admin, ids.admin)).rejects.toThrow(/Profile/)
    await addSession(ids.meera)
    expect(await users.signOutEverywhere(actors.admin, ids.meera)).toBe(1)

    const org = await orgs.createOrganization(actors.admin, { name: "Acme Corp", domain: "https://ACME.example/" })
    await expect(orgs.createOrganization(actors.admin, { name: "acme corp" })).rejects.toThrow(/already exists/)
    await users.updateUserDetails(actors.admin, ids.meera, { fullName: "Meera K", department: "Finance", managerId: ids.admin, organizationId: org })
    const d = await users.getUserDetail(actors.admin, ids.meera)
    expect(d.user).toMatchObject({ full_name: "Meera K", department: "Finance", manager_id: ids.admin, organization_id: org, organization_name: "Acme Corp" })
    await expect(users.updateUserDetails(actors.admin, ids.meera, { fullName: "Meera", managerId: ids.meera })).rejects.toThrow(/own manager/)
    const list = await users.listUsers(actors.admin, { q: "meera k", org })
    expect(list.rows.map((r) => r.id)).toEqual([ids.meera])
  })

  it("keeps people inside their tenant", async () => {
    const other = await q1<{ id: string }>("select id from users where tenant_id <> $1 limit 1", [tenantId])
    if (!other) return
    await expect(users.getUserDetail(actors.admin, other.id)).rejects.toThrow(/not found/i)
    await expect(users.setUserEnabled(actors.admin, other.id, false)).rejects.toThrow(/not found/i)
    await expect(users.setUserRole(actors.admin, other.id, "user")).rejects.toThrow(/not found/i)
  })

  it("manages custom roles without handing out more than you hold", async () => {
    await expect(roles.createCustomRole(actors.admin, { key: "admin", name: "x" })).rejects.toThrow(/reserved/)
    await expect(roles.createCustomRole(actors.admin, { key: "Bad Key", name: "x" })).rejects.toThrow(/lowercase/)
    const id = await roles.createCustomRole(actors.admin, { key: "people_admin", name: "People admin", permissions: ["admin.users", "ticket.create", "admin.tenants"] })
    const r = await roles.getCustomRole(actors.admin, id)
    expect(r.permissions).toEqual(["admin.users", "ticket.create"])
    await expect(roles.createCustomRole(actors.admin, { key: "people_admin", name: "Again" })).rejects.toThrow(/already exists/)

    await seedUser("helen", "people_admin")
    expect(actors.helen.permissions.has("admin.users")).toBe(true)
    // Helen may manage users but cannot hand out a role holding more than she has
    await seedUser("john", "user")
    await expect(users.setUserRole(actors.helen, ids.john, "admin")).rejects.toThrow(/permissions you do not hold/)
    expect(await users.setUserRole(actors.helen, ids.john, "people_admin")).toBe(true)
    // nor change an account that holds more than she has
    await expect(users.setUserEnabled(actors.helen, ids.meera, false)).rejects.toThrow(/permissions you do not have/)
    await expect(users.setUserEnabled(actors.helen, ids.admin, false)).rejects.toThrow(/permissions you do not have/)
    await users.setUserRole(actors.admin, ids.john, "user")
    await expect(roles.createCustomRole(actors.helen, { key: "sneaky", name: "Sneaky", permissions: ["admin.settings"] })).rejects.toThrow(/do not hold/)
    await expect(roles.updateCustomRole(actors.helen, id, { name: "People admin", permissions: ["ticket.create"] })).rejects.toThrow(/lock you out/)

    await expect(roles.deleteCustomRole(actors.admin, id)).rejects.toThrow(/hold this role|holds this role/)
    await roles.updateCustomRole(actors.admin, id, { name: "People administrator", permissions: ["admin.users", "ticket.create", "report.view"] })
    expect((await lastAudit(id))?.data).toMatchObject({ added: ["report.view"], removed: [] })
    await users.setUserRole(actors.admin, ids.helen, "user")
    await roles.deleteCustomRole(actors.admin, id)
    expect((await lastAudit(id))?.action).toBe("admin.role_deleted")
  })

  it("manages groups and refuses to delete one that open tickets use", async () => {
    const gid = await groups.createGroup(actors.admin, { name: "Network team", kind: "support", email: "net@admin.test" })
    await expect(groups.createGroup(actors.admin, { name: "network TEAM" })).rejects.toThrow(/already exists/)
    expect(await groups.addGroupMember(actors.admin, gid, ids.ravi)).toBe(true)
    expect(await groups.addGroupMember(actors.admin, gid, ids.ravi)).toBe(false)
    const r = await users.setUserGroups(actors.admin, ids.meera, [gid])
    expect(r).toEqual({ added: 1, removed: 0 })
    expect((await groups.getGroup(actors.admin, gid)).members).toHaveLength(2)
    expect(await groups.removeGroupMember(actors.admin, gid, ids.meera)).toBe(true)

    await createTicket(actors.admin, { type: "incident", subject: "Switch down in building B", assignmentGroupId: gid })
    await expect(groups.deleteGroup(actors.admin, gid)).rejects.toThrow(/open ticket/)
    await groups.updateGroup(actors.admin, gid, { name: "Network team", kind: "support", isActive: "" })
    expect((await groups.getGroup(actors.admin, gid)).group.is_active).toBe(false)
    expect((await lastAudit(gid))?.action).toBe("admin.group_deactivated")

    const spare = await groups.createGroup(actors.admin, { name: "Spare" })
    await groups.deleteGroup(actors.admin, spare)
    expect((await lastAudit(spare))?.action).toBe("admin.group_deleted")
  })

  it("manages the category tree and protects used categories", async () => {
    const parent = await itsm.createCategory(actors.admin, { name: "Facilities", ticketTypes: ["incident", "service_request"] })
    const child = await itsm.createCategory(actors.admin, { name: "Air conditioning", parentId: parent })
    await expect(itsm.createCategory(actors.admin, { name: "Too deep", parentId: child })).rejects.toThrow(/two levels/)
    await expect(itsm.createCategory(actors.admin, { name: "air CONDITIONING", parentId: parent })).rejects.toThrow(/already exists/)
    const cats = await itsm.listCategoriesAdmin(actors.admin)
    expect(cats.find((c) => c.id === parent)?.ticket_types).toEqual(["incident", "service_request"])
    await createTicket(actors.admin, { type: "incident", subject: "Too warm in room 4", categoryId: child })
    await expect(itsm.deleteCategory(actors.admin, parent)).rejects.toThrow(/Deactivate it instead/)
    await itsm.updateCategory(actors.admin, child, { name: "HVAC", sortOrder: 5, isActive: "" })
    const updated = (await itsm.listCategoriesAdmin(actors.admin)).find((c) => c.id === child)
    expect(updated).toMatchObject({ name: "HVAC", sort_order: 5, is_active: false, ticket_count: 1 })
    const unused = await itsm.createCategory(actors.admin, { name: "Unused" })
    await itsm.deleteCategory(actors.admin, unused)
  })

  it("saves the priority matrix and the calendar", async () => {
    const cells = Object.fromEntries((await itsm.getMatrix(actors.admin)).map((c) => [`${c.impact}.${c.urgency}`, c.priority]))
    cells["low.low"] = "medium"
    expect(await itsm.saveMatrix(actors.admin, cells)).toBe(1)
    expect((await itsm.getMatrix(actors.admin)).find((c) => c.impact === "low" && c.urgency === "low")?.priority).toBe("medium")
    await expect(itsm.saveMatrix(actors.admin, { ...cells, "high.high": "urgent" })).rejects.toThrow(/Choose a priority/)

    const changed = await itsm.saveCalendar(actors.admin, {
      timezone: "Asia/Kolkata",
      workDays: ["1", "2", "3", "4", "5", "6"],
      workStart: "09:30",
      workEnd: "18:30",
      holidays: "2026-12-25 Christmas\n2026-01-26 Republic Day",
      holdMaxHours: "48",
      reopenWindowDays: "10",
      autoCloseResolvedDays: "5",
      strictAssignment: null,
    })
    expect(changed).toEqual(expect.arrayContaining(["timezone", "work_days", "holidays", "strict_assignment"]))
    const s = await loadTenantSettings(tenantId)
    expect(s).toMatchObject({
      timezone: "Asia/Kolkata",
      work_days: [1, 2, 3, 4, 5, 6],
      work_start: "09:30",
      work_end: "18:30",
      holidays: ["2026-01-26", "2026-12-25"],
      hold_max_hours: 48,
      reopen_window_days: 10,
      auto_close_resolved_days: 5,
      strict_assignment: false,
    })
    expect((await lastAudit(tenantId))?.action).toBe("admin.itsm_calendar_updated")
  })

  it("respects the one-policy-per-type-and-priority rule for SLAs and OLAs", async () => {
    const base = { kind: "sla", ticketType: "problem", priority: "high", responseHours: "1", responseMinutes: "30", resolutionHours: "8", resolutionMinutes: "0", businessHours: "on" }
    const id = await sla.createSlaPolicy(actors.admin, base)
    const p = await sla.getSlaPolicy(actors.admin, id)
    expect(p).toMatchObject({ response_minutes: 90, resolution_minutes: 480, business_hours: true, warn_percent: 75 })
    await expect(sla.createSlaPolicy(actors.admin, base)).rejects.toThrow(/already an SLA policy/)
    await expect(sla.createSlaPolicy(actors.admin, { ...base, priority: "low", resolutionHours: "1", resolutionMinutes: "0" })).rejects.toThrow(/cannot be shorter/)
    // "all types" is its own slot
    const all = await sla.createSlaPolicy(actors.admin, { ...base, ticketType: "" })
    expect((await sla.getSlaPolicy(actors.admin, all)).ticket_type).toBeNull()

    const gid = await groups.createGroup(actors.admin, { name: "Desk OLA" })
    await expect(sla.createSlaPolicy(actors.admin, { ...base, kind: "ola" })).rejects.toThrow(/support group/)
    const ola = await sla.createSlaPolicy(actors.admin, { ...base, kind: "ola", groupId: gid })
    await expect(sla.createSlaPolicy(actors.admin, { ...base, kind: "ola", groupId: gid })).rejects.toThrow(/already has an OLA/)
    await sla.updateSlaPolicy(actors.admin, ola, { ...base, kind: "ola", groupId: gid, responseMinutes: "45", isActive: "" })
    expect(await sla.getSlaPolicy(actors.admin, ola)).toMatchObject({ response_minutes: 105, is_active: false })
    await sla.deleteSlaPolicy(actors.admin, all)
    await expect(sla.getSlaPolicy(actors.admin, all)).rejects.toThrow(/not found/i)
  })

  it("manages custom fields, templates and maintenance windows", async () => {
    await expect(fields.createCustomField(actors.admin, { key: "Cost Centre", label: "x", fieldType: "text" })).rejects.toThrow(/lowercase/)
    await expect(fields.createCustomField(actors.admin, { key: "cost_centre", label: "Cost centre", fieldType: "select", options: "" })).rejects.toThrow(/at least one option/)
    const fid = await fields.createCustomField(actors.admin, { key: "cost_centre", label: "Cost centre", fieldType: "select", options: "CC-100\nCC-200", ticketTypes: ["incident"] })
    await expect(fields.createCustomField(actors.admin, { key: "cost_centre", label: "Again", fieldType: "text" })).rejects.toThrow(/already exists/)
    await fields.updateCustomField(actors.admin, fid, { key: "renamed", label: "Cost center", fieldType: "select", options: "CC-100\nCC-300", required: "on" })
    const f = await fields.getCustomField(actors.admin, fid)
    expect(f).toMatchObject({ key: "cost_centre", label: "Cost center", options: ["CC-100", "CC-300"], required: true, ticket_types: null })

    await templates.saveTemplate(actors.admin, "ticket.created", { subject: "[{{ticket.number}}] Got it", body: "Hi {{recipient.name}}\n\n{{ticket.url}}" })
    expect((await templates.listTemplatesAdmin(actors.admin)).find((t) => t.key === "ticket.created")?.overridden).toBe(true)
    await expect(templates.saveTemplate(actors.admin, "nope", { subject: "x", body: "y" })).rejects.toThrow(/Unknown template/)
    expect(await templates.resetTemplate(actors.admin, "ticket.created")).toBe(true)
    expect((await templates.getTemplateAdmin(actors.admin, "ticket.created")).override).toBeNull()

    // actors read the tenant's time zone at sign-in; refresh after the calendar change
    const admin = (await actorForUser(ids.admin, "session-admin"))!
    const wid = await windows.createWindow(admin, {
      name: "Weekly patching",
      kind: "maintenance",
      appliesTo: "patches",
      startsAt: "2026-12-06T02:00",
      endsAt: "2026-12-06T04:00",
      recurrence: "weekly",
    })
    const w = await windows.getWindow(admin, wid)
    expect(w.starts_at.toISOString()).toBe("2026-12-05T20:30:00.000Z") // Asia/Kolkata
    expect(w.recurrence).toBe("weekly")
    await windows.deleteWindow(admin, wid)
    expect((await lastAudit(wid))?.action).toBe("admin.maintenance_window_deleted")
  })

  it("re-checks permissions inside the services", async () => {
    await seedUser("eng", "engineer")
    await expect(users.listUsers(actors.eng, {})).rejects.toThrow(/permission/)
    await expect(itsm.saveMatrix(actors.eng, {})).rejects.toThrow(/permission/)
    await expect(groups.createGroup(actors.eng, { name: "x" })).rejects.toThrow(/permission/)
    const all = await q<{ action: string }>("select action from audit_log where tenant_id = $1 and action like 'admin.%'", [tenantId])
    expect(all.length).toBeGreaterThan(20)
  })
})
