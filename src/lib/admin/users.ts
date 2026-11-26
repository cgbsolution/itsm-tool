/**
 * Administration of people: user accounts, roles, status, sign-in security
 * and group memberships. Every function re-checks admin.users, filters on the
 * actor's (selected) tenant and writes the audit log. Passwords and tokens are
 * never logged.
 */
import { q, q1, exec, tx, Params, isUuid, isUniqueViolation, type Db, pool } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { hashPassword, passwordProblem } from "@/lib/auth/password"
import { SYSTEM_ROLES, permissionsFor, type Permission } from "@/lib/auth/permissions"
import { loadTenantSettings } from "@/lib/itsm/config"
import { queueEmail, smtpConfigured } from "@/lib/email/send"
import { config } from "@/lib/config"
import { randomToken, sha256Hex } from "@/lib/crypto"
import { assertCanGrant, assertPermission, auditActor, rolePermissions } from "@/lib/admin/guard"
import { normalizeEmail, optionalText, requiredText } from "@/lib/admin/rules"

export const USER_STATUSES = ["active", "invited", "disabled"] as const
export const INVITE_HOURS = 72
export const RESET_HOURS = 2

/* ── reads ─────────────────────────────────────────────────────────────── */

export type UserFilters = { q?: string; role?: string; status?: string; org?: string; page?: number; pageSize?: number }

export type UserListRow = {
  id: string
  email: string
  full_name: string
  role: string
  status: "active" | "invited" | "disabled"
  auth_source: "local" | "ldap" | "oidc"
  mfa_enabled: boolean
  last_login_at: Date | null
  locked: boolean
  department: string | null
  organization_name: string | null
  total: number
}

export async function listUsers(actor: Actor, f: UserFilters) {
  assertPermission(actor, "admin.users")
  const p = new Params()
  const where = [`u.tenant_id = ${p.add(actor.tenantId)}`]
  const text = f.q?.trim()
  if (text) {
    const like = p.add(`%${text.replace(/[\\%_]/g, (c) => "\\" + c)}%`)
    where.push(`(u.full_name ilike ${like} or u.email ilike ${like})`)
  }
  if (f.role) where.push(`u.role = ${p.add(f.role)}`)
  if (f.status === "locked") where.push("u.locked_until > now()")
  else if (f.status && (USER_STATUSES as readonly string[]).includes(f.status)) where.push(`u.status = ${p.add(f.status)}`)
  if (f.org === "none") where.push("u.organization_id is null")
  else if (f.org && isUuid(f.org)) where.push(`u.organization_id = ${p.add(f.org)}`)
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 5), 200)
  const page = Math.max(f.page ?? 1, 1)
  const rows = await q<UserListRow>(
    `select u.id, u.email, u.full_name, u.role, u.status, u.auth_source, u.mfa_enabled, u.last_login_at,
            coalesce(u.locked_until > now(), false) as locked, u.department, o.name as organization_name,
            count(*) over () as total
       from users u left join organizations o on o.id = u.organization_id
      where ${where.join(" and ")}
      order by lower(coalesce(nullif(u.full_name, ''), u.email)), u.email
      limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export type UserDetail = {
  id: string
  email: string
  full_name: string
  role: string
  status: "active" | "invited" | "disabled"
  auth_source: "local" | "ldap" | "oidc"
  has_password: boolean
  must_change_password: boolean
  mfa_enabled: boolean
  failed_logins: number
  locked_until: Date | null
  locked: boolean
  last_login_at: Date | null
  last_seen_at: Date | null
  password_changed_at: Date | null
  phone: string | null
  employee_id: string | null
  designation: string | null
  department: string | null
  location: string | null
  manager_id: string | null
  manager_name: string | null
  organization_id: string | null
  organization_name: string | null
  external_id: string | null
  created_at: Date
}

export async function getUserDetail(actor: Actor, userId: string) {
  assertPermission(actor, "admin.users")
  if (!isUuid(userId)) throw notFound("User not found")
  const user = await q1<UserDetail>(
    `select u.id, u.email, u.full_name, u.role, u.status, u.auth_source, u.password_hash is not null as has_password,
            u.must_change_password, u.mfa_enabled, u.failed_logins, u.locked_until, coalesce(u.locked_until > now(), false) as locked,
            u.last_login_at, u.last_seen_at, u.password_changed_at, u.phone, u.employee_id, u.designation, u.department, u.location,
            u.manager_id, m.full_name as manager_name, u.organization_id, o.name as organization_name, u.external_id, u.created_at
       from users u
       left join users m on m.id = u.manager_id
       left join organizations o on o.id = u.organization_id
      where u.id = $1 and u.tenant_id = $2`,
    [userId, actor.tenantId]
  )
  if (!user) throw notFound("User not found")
  const [groups, sessions] = await Promise.all([
    q<{ group_id: string }>(
      "select gm.group_id from group_members gm join groups g on g.id = gm.group_id where gm.user_id = $1 and g.tenant_id = $2",
      [userId, actor.tenantId]
    ),
    q1<{ n: number }>("select count(*) as n from sessions where user_id = $1 and expires_at > now()", [userId]),
  ])
  return { user, groupIds: groups.map((g) => g.group_id), activeSessions: sessions?.n ?? 0 }
}

export type RoleOption = { key: string; name: string; description: string | null; system: boolean; permissions: Permission[]; grantable: boolean }

/** System roles then custom roles, with whether the actor may hand each out. */
export async function roleCatalog(actor: Actor, db: Db = pool()): Promise<RoleOption[]> {
  const custom = await q<{ key: string; name: string; description: string | null; permissions: string[] }>(
    "select key, name, description, permissions from custom_roles where tenant_id = $1 order by name",
    [actor.tenantId],
    db
  )
  const grantable = (key: string, perms: Set<Permission>) =>
    actor.isSuperadmin || (key !== "superadmin" && [...perms].every((p) => actor.permissions.has(p)))
  const out: RoleOption[] = []
  for (const [key, r] of Object.entries(SYSTEM_ROLES)) {
    const perms = permissionsFor(key)
    out.push({ key, name: r.name, description: r.description, system: true, permissions: [...perms], grantable: grantable(key, perms) })
  }
  for (const r of custom) {
    const perms = permissionsFor(r.key, r.permissions)
    out.push({ key: r.key, name: r.name, description: r.description, system: false, permissions: [...perms], grantable: grantable(r.key, perms) })
  }
  return out
}

/** Why the actor cannot change this account, or null when they can. */
export function manageProblem(actor: Actor, targetRole: string, roles: RoleOption[]): string | null {
  if (actor.isSuperadmin) return null
  if (targetRole === "superadmin") return "Only a super administrator can change a super administrator's account."
  const role = roles.find((r) => r.key === targetRole)
  if (role && !role.grantable) return "This account holds permissions you do not have, so you cannot change it."
  return null
}

/** People for manager / member selects (active accounts in the tenant). */
export async function peopleOptions(actor: Actor, db: Db = pool()) {
  return q<{ id: string; full_name: string; email: string }>(
    `select id, full_name, email from users where tenant_id = $1 and status = 'active'
      order by lower(coalesce(nullif(full_name, ''), email)) limit 2000`,
    [actor.tenantId],
    db
  )
}

/* ── shared write helpers ──────────────────────────────────────────────── */

type Target = { id: string; email: string; full_name: string; role: string; status: string; auth_source: string; has_password: boolean; mfa_enabled: boolean }

/** Locks a user of the actor's tenant that the actor is allowed to change. */
async function loadTarget(db: Db, actor: Actor, userId: string, opts: { checkGrant?: boolean } = {}): Promise<Target> {
  if (!isUuid(userId)) throw notFound("User not found")
  const u = await q1<Target>(
    `select id, email, full_name, role, status, auth_source, password_hash is not null as has_password, mfa_enabled
       from users where id = $1 and tenant_id = $2 for update`,
    [userId, actor.tenantId],
    db
  )
  if (!u) throw notFound("User not found")
  if (opts.checkGrant !== false && u.id !== actor.id) {
    const perms = (await rolePermissions(actor.tenantId, u.role, db)) ?? new Set<Permission>()
    assertCanGrant(actor, u.role, perms, "change")
  }
  return u
}

async function userRef(db: Db, tenantId: string, id: unknown, label: string): Promise<string | null> {
  const v = String(id ?? "").trim()
  if (!v) return null
  if (!isUuid(v)) throw new AppError(`${label}: choose someone from the list`)
  const u = await q1("select 1 from users where id = $1 and tenant_id = $2", [v, tenantId], db)
  if (!u) throw new AppError(`${label}: that person is not in this tenant`)
  return v
}

async function orgRef(db: Db, tenantId: string, id: unknown): Promise<string | null> {
  const v = String(id ?? "").trim()
  if (!v) return null
  if (!isUuid(v)) throw new AppError("Organisation: choose one from the list")
  const o = await q1("select 1 from organizations where id = $1 and tenant_id = $2", [v, tenantId], db)
  if (!o) throw new AppError("Organisation: that organisation does not exist")
  return v
}

async function revokeSessions(db: Db, userId: string, exceptSessionId?: string): Promise<number> {
  return exceptSessionId
    ? exec("delete from sessions where user_id = $1 and id <> $2", [userId, exceptSessionId], db)
    : exec("delete from sessions where user_id = $1", [userId], db)
}

/** Creates a single-use link token and queues the invitation / reset email. */
async function sendLink(db: Db, tenantId: string, user: { id: string; email: string; full_name: string }, purpose: "invite" | "reset"): Promise<string> {
  const token = randomToken(32)
  const hours = purpose === "invite" ? INVITE_HOURS : RESET_HOURS
  await exec(
    "insert into auth_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4))",
    [sha256Hex(token), user.id, purpose, hours],
    db
  )
  await queueEmail(
    {
      tenantId,
      to: user.email,
      template: purpose === "invite" ? "user.invite" : "user.password_reset",
      vars: { link: `${config.appUrl()}/reset/${token}`, hours, recipient: { name: user.full_name || user.email } },
      relatedType: "user",
      relatedId: user.id,
    },
    db
  )
  return `${config.appUrl()}/reset/${token}`
}

function sourceLabel(source: string) {
  return source === "ldap" ? "LDAP" : source === "oidc" ? "single sign-on (OIDC)" : "a password"
}

/* ── create ────────────────────────────────────────────────────────────── */

export type CreateUserInput = {
  email: unknown
  fullName: unknown
  role: unknown
  department?: unknown
  designation?: unknown
  phone?: unknown
  managerId?: unknown
  organizationId?: unknown
  /** invite: an email with a link to set a password; password: a temporary password the user must change */
  mode: unknown
  password?: unknown
}

export async function createUser(actor: Actor, input: CreateUserInput): Promise<{ id: string; invited: boolean }> {
  assertPermission(actor, "admin.users")
  const email = normalizeEmail(input.email)
  const fullName = requiredText(input.fullName, 200, "Name")
  const role = String(input.role ?? "").trim()
  const department = optionalText(input.department, 200, "Department")
  const designation = optionalText(input.designation, 200, "Designation")
  const phone = optionalText(input.phone, 50, "Phone")
  if (input.mode !== "invite" && input.mode !== "password") throw new AppError("Choose how the person gets a password")
  const invited = input.mode === "invite"

  // validate and hash before opening the transaction (bcrypt is slow)
  let passwordHash: string | null = null
  if (!invited) {
    const password = String(input.password ?? "")
    const settings = await loadTenantSettings(actor.tenantId)
    const problem = passwordProblem(password, settings.password_min_length, email)
    if (problem) throw new AppError(`Temporary password: ${problem}`)
    passwordHash = await hashPassword(password)
  }

  try {
    return await tx(async (db) => {
      const perms = await rolePermissions(actor.tenantId, role, db)
      if (!perms) throw new AppError("Choose a role")
      assertCanGrant(actor, role, perms, "assign")
      const managerId = await userRef(db, actor.tenantId, input.managerId, "Manager")
      const organizationId = await orgRef(db, actor.tenantId, input.organizationId)
      if (await q1("select 1 from users where lower(email) = $1", [email], db)) throw new AppError("An account with that email address already exists")
      const row = await q1<{ id: string }>(
        `insert into users (tenant_id, email, full_name, role, status, auth_source, password_hash, password_changed_at,
                            must_change_password, department, designation, phone, manager_id, organization_id)
         values ($1, $2, $3, $4, $5, 'local', $6, case when $6::text is null then null else now() end, $7, $8, $9, $10, $11, $12)
         returning id`,
        [actor.tenantId, email, fullName, role, invited ? "invited" : "active", passwordHash, !invited, department, designation, phone, managerId, organizationId],
        db
      )
      const id = row!.id
      if (invited) await sendLink(db, actor.tenantId, { id, email, full_name: fullName }, "invite")
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: "admin.user_created",
          entityType: "user",
          entityId: id,
          summary: `${fullName} <${email}> created as ${role}${invited ? " (invited)" : " (temporary password)"}`,
          data: { email, role, method: invited ? "invite" : "temporary_password" },
        },
        db
      )
      return { id, invited }
    })
  } catch (e) {
    if (isUniqueViolation(e, "users_email_key")) throw new AppError("An account with that email address already exists")
    throw e
  }
}

/* ── update details ────────────────────────────────────────────────────── */

export type UpdateUserInput = {
  fullName: unknown
  email?: unknown
  department?: unknown
  designation?: unknown
  phone?: unknown
  employeeId?: unknown
  location?: unknown
  managerId?: unknown
  organizationId?: unknown
}

export async function updateUserDetails(actor: Actor, userId: string, input: UpdateUserInput): Promise<void> {
  assertPermission(actor, "admin.users")
  const next = {
    full_name: requiredText(input.fullName, 200, "Name"),
    department: optionalText(input.department, 200, "Department"),
    designation: optionalText(input.designation, 200, "Designation"),
    phone: optionalText(input.phone, 50, "Phone"),
    employee_id: optionalText(input.employeeId, 100, "Employee ID"),
    location: optionalText(input.location, 200, "Location"),
  }
  try {
    await tx(async (db) => {
      const target = await loadTarget(db, actor, userId)
      const before = await q1<Record<string, unknown>>(
        "select full_name, email, department, designation, phone, employee_id, location, manager_id, organization_id from users where id = $1",
        [target.id],
        db
      )
      const managerId = await userRef(db, actor.tenantId, input.managerId, "Manager")
      if (managerId === target.id) throw new AppError("Someone cannot be their own manager")
      const organizationId = await orgRef(db, actor.tenantId, input.organizationId)
      let email = target.email
      if (input.email !== undefined && String(input.email).trim().toLowerCase() !== target.email.toLowerCase()) {
        if (target.auth_source !== "local") throw new AppError(`The email address of this account comes from ${sourceLabel(target.auth_source)} and cannot be changed here`)
        email = normalizeEmail(input.email)
        if (await q1("select 1 from users where lower(email) = $1 and id <> $2", [email, target.id], db)) throw new AppError("An account with that email address already exists")
      }
      const after: Record<string, unknown> = { ...next, email, manager_id: managerId, organization_id: organizationId }
      const changed = Object.keys(after).filter((k) => (before?.[k] ?? null) !== (after[k] ?? null))
      if (!changed.length) return
      await exec(
        `update users set full_name = $2, email = $3, department = $4, designation = $5, phone = $6, employee_id = $7, location = $8,
                manager_id = $9, organization_id = $10, updated_at = now()
          where id = $1 and tenant_id = $11`,
        [target.id, next.full_name, email, next.department, next.designation, next.phone, next.employee_id, next.location, managerId, organizationId, actor.tenantId],
        db
      )
      const data: Record<string, unknown> = { fields: changed }
      if (changed.includes("email")) data.email = { from: target.email, to: email }
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.user_updated", entityType: "user", entityId: target.id, summary: `Details of ${email} changed: ${changed.join(", ")}`, data },
        db
      )
    })
  } catch (e) {
    if (isUniqueViolation(e, "users_email_key")) throw new AppError("An account with that email address already exists")
    throw e
  }
}

/* ── role ──────────────────────────────────────────────────────────────── */

/** Changes a user's role and signs them out everywhere. */
export async function setUserRole(actor: Actor, userId: string, role: unknown): Promise<boolean> {
  assertPermission(actor, "admin.users")
  if (userId === actor.id) throw new AppError("You cannot change your own role. Ask another administrator.")
  const key = String(role ?? "").trim()
  return tx(async (db) => {
    const target = await loadTarget(db, actor, userId)
    if (target.role === key) return false
    const perms = await rolePermissions(actor.tenantId, key, db)
    if (!perms) throw new AppError("Choose a role")
    assertCanGrant(actor, key, perms, "assign")
    await exec("update users set role = $2, updated_at = now() where id = $1 and tenant_id = $3", [target.id, key, actor.tenantId], db)
    const revoked = await revokeSessions(db, target.id)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.user_role_changed",
        entityType: "user",
        entityId: target.id,
        summary: `Role of ${target.email} changed from ${target.role} to ${key}`,
        data: { from: target.role, to: key, sessions_revoked: revoked },
      },
      db
    )
    return true
  })
}

/* ── status ────────────────────────────────────────────────────────────── */

/** Enables or disables an account. Disabling signs the person out and voids their open links. */
export async function setUserEnabled(actor: Actor, userId: string, enabled: boolean): Promise<boolean> {
  assertPermission(actor, "admin.users")
  if (!enabled && userId === actor.id) throw new AppError("You cannot disable your own account")
  return tx(async (db) => {
    const target = await loadTarget(db, actor, userId)
    if (enabled) {
      if (target.status !== "disabled") return false
      // an account that never set a password goes back to "invited"
      const status = target.auth_source === "local" && !target.has_password ? "invited" : "active"
      await exec("update users set status = $2, failed_logins = 0, locked_until = null, updated_at = now() where id = $1", [target.id, status], db)
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.user_enabled", entityType: "user", entityId: target.id, summary: `${target.email} enabled`, data: { status } },
        db
      )
      return true
    }
    if (target.status === "disabled") return false
    await exec("update users set status = 'disabled', updated_at = now() where id = $1", [target.id], db)
    const revoked = await revokeSessions(db, target.id)
    await exec("update auth_tokens set used_at = now() where user_id = $1 and used_at is null", [target.id], db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.user_disabled",
        entityType: "user",
        entityId: target.id,
        summary: `${target.email} disabled`,
        data: { previous_status: target.status, sessions_revoked: revoked },
      },
      db
    )
    return true
  })
}

/* ── sign-in security ──────────────────────────────────────────────────── */

/**
 * Emails a password link: a new invitation for invited accounts, otherwise a reset link.
 * When no SMTP server is configured the link is returned so the admin can hand it over
 * (shown once, audited).
 */
export async function sendPasswordLink(actor: Actor, userId: string): Promise<{ purpose: "invite" | "reset"; link: string | null }> {
  assertPermission(actor, "admin.users")
  return tx(async (db) => {
    const target = await loadTarget(db, actor, userId)
    if (target.auth_source !== "local") throw new AppError(`This account signs in with ${sourceLabel(target.auth_source)}; its password is managed there`)
    if (target.status === "disabled") throw new AppError("Enable the account before sending a password link")
    const purpose = target.status === "invited" ? "invite" : "reset"
    const link = await sendLink(db, actor.tenantId, target, purpose)
    const deliverable = await smtpConfigured(actor.tenantId)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: purpose === "invite" ? "admin.user_invite_sent" : "admin.user_password_reset_sent",
        entityType: "user",
        entityId: target.id,
        summary: `${purpose === "invite" ? "Invitation" : "Password reset link"} ${deliverable ? "sent to" : "shown to the administrator for"} ${target.email}`,
      },
      db
    )
    return { purpose, link: deliverable ? null : link }
  })
}

/** Turns two-step sign-in off so the person can enrol again (lost phone). */
export async function resetUserMfa(actor: Actor, userId: string): Promise<boolean> {
  assertPermission(actor, "admin.users")
  if (userId === actor.id) throw new AppError("Change your own two-step sign-in from Profile & security")
  return tx(async (db) => {
    const target = await loadTarget(db, actor, userId)
    const n = await exec(
      `update users set mfa_enabled = false, mfa_secret_enc = null, mfa_recovery_hashes = '{}', updated_at = now()
        where id = $1 and (mfa_enabled or mfa_secret_enc is not null or cardinality(mfa_recovery_hashes) > 0)`,
      [target.id],
      db
    )
    if (!n) return false
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.user_mfa_reset", entityType: "user", entityId: target.id, summary: `Two-step sign-in reset for ${target.email}` },
      db
    )
    return true
  })
}

/** Clears failed sign-in attempts and a lockout. */
export async function unlockUser(actor: Actor, userId: string): Promise<boolean> {
  assertPermission(actor, "admin.users")
  return tx(async (db) => {
    const target = await loadTarget(db, actor, userId)
    const n = await exec(
      "update users set failed_logins = 0, locked_until = null, updated_at = now() where id = $1 and (failed_logins > 0 or locked_until is not null)",
      [target.id],
      db
    )
    if (!n) return false
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.user_unlocked", entityType: "user", entityId: target.id, summary: `${target.email} unlocked` },
      db
    )
    return true
  })
}

/** Ends every session of a user (your own: every session except this one). */
export async function signOutEverywhere(actor: Actor, userId: string): Promise<number> {
  assertPermission(actor, "admin.users")
  return tx(async (db) => {
    const target = await loadTarget(db, actor, userId)
    const n = await revokeSessions(db, target.id, target.id === actor.id ? actor.sessionId : undefined)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.user_sessions_revoked",
        entityType: "user",
        entityId: target.id,
        summary: `${target.email} signed out of ${n} session${n === 1 ? "" : "s"}`,
        data: { sessions: n },
      },
      db
    )
    return n
  })
}

/* ── groups ────────────────────────────────────────────────────────────── */

/** Replaces a user's memberships in this tenant's groups. */
export async function setUserGroups(actor: Actor, userId: string, groupIds: string[]): Promise<{ added: number; removed: number }> {
  assertPermission(actor, "admin.users")
  const wanted = [...new Set(groupIds.filter(Boolean))]
  if (wanted.some((g) => !isUuid(g))) throw new AppError("Unknown group")
  return tx(async (db) => {
    // membership is not a permission grant, so no role check here
    const target = await loadTarget(db, actor, userId, { checkGrant: false })
    const valid = await q<{ id: string; name: string }>("select id, name from groups where tenant_id = $1 and id = any($2::uuid[])", [actor.tenantId, wanted], db)
    if (valid.length !== wanted.length) throw new AppError("Unknown group")
    const current = await q<{ id: string; name: string }>(
      "select g.id, g.name from group_members gm join groups g on g.id = gm.group_id where gm.user_id = $1 and g.tenant_id = $2",
      [target.id, actor.tenantId],
      db
    )
    const add = valid.filter((g) => !current.some((c) => c.id === g.id))
    const remove = current.filter((c) => !wanted.includes(c.id))
    if (!add.length && !remove.length) return { added: 0, removed: 0 }
    if (remove.length) await exec("delete from group_members where user_id = $1 and group_id = any($2::uuid[])", [target.id, remove.map((g) => g.id)], db)
    if (add.length) {
      await exec("insert into group_members (group_id, user_id) select unnest($2::uuid[]), $1 on conflict do nothing", [target.id, add.map((g) => g.id)], db)
    }
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.user_groups_changed",
        entityType: "user",
        entityId: target.id,
        summary: `Groups of ${target.email} changed`,
        data: { added: add.map((g) => g.name), removed: remove.map((g) => g.name) },
      },
      db
    )
    return { added: add.length, removed: remove.length }
  })
}
