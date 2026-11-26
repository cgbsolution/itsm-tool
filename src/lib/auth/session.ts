/**
 * Cookie sessions. The cookie holds a random token; the database stores only
 * its SHA-256. httpOnly + SameSite=Lax (+ Secure behind HTTPS).
 */
import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"
import { q, q1, exec } from "@/lib/db"
import { config } from "@/lib/config"
import { randomToken, sha256Hex } from "@/lib/crypto"
import { permissionsFor, SYSTEM_ROLES, isSystemRole, type Permission } from "@/lib/auth/permissions"

export const SESSION_COOKIE = "itsm_session"
export const TENANT_COOKIE = "itsm_tenant"

export type TenantInfo = {
  id: string
  name: string
  slug: string
  brandName: string
  brandColor: string
  timezone: string
  requireMfa: boolean
  strictAssignment: boolean
  status: string
}

export type Actor = {
  id: string
  email: string
  name: string
  role: string
  roleName: string
  /** The tenant the actor is working in (a super admin can switch) */
  tenantId: string
  homeTenantId: string
  tenant: TenantInfo
  permissions: Set<Permission>
  groupIds: string[]
  isSuperadmin: boolean
  mfaEnabled: boolean
  mustChangePassword: boolean
  sessionId: string
  /** Background jobs act as the system (no user id is recorded) */
  isSystem?: boolean
}

type SessionRow = {
  session_id: string
  mfa_pending: boolean
  last_seen_at: Date
  user_id: string
  email: string
  full_name: string
  role: string
  status: string
  tenant_id: string
  mfa_enabled: boolean
  must_change_password: boolean
}

export function can(actor: Actor | null | undefined, perm: Permission): boolean {
  return !!actor && actor.permissions.has(perm)
}

export async function clientIp(): Promise<string | null> {
  const h = await headers()
  const fwd = h.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64)
  return h.get("x-real-ip")?.slice(0, 64) ?? null
}

async function loadTenant(tenantId: string): Promise<TenantInfo | null> {
  const row = await q1<{
    id: string
    name: string
    slug: string
    brand_name: string | null
    brand_color: string | null
    timezone: string | null
    require_mfa: boolean | null
    strict_assignment: boolean | null
    status: string
  }>(
    `select t.id, t.name, t.slug, t.status, s.brand_name, s.brand_color, s.timezone, s.require_mfa, s.strict_assignment
       from tenants t left join tenant_settings s on s.tenant_id = t.id
      where t.id = $1`,
    [tenantId]
  )
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brandName: row.brand_name || row.name || config.productName(),
    brandColor: row.brand_color || "#2563eb",
    timezone: row.timezone || "UTC",
    requireMfa: !!row.require_mfa,
    strictAssignment: row.strict_assignment ?? true,
    status: row.status,
  }
}

/** Builds the actor for a user id (also used by API-token requests). */
export async function actorForUser(userId: string, sessionId: string, tenantOverride?: string | null): Promise<Actor | null> {
  const u = await q1<{
    id: string
    email: string
    full_name: string
    role: string
    status: string
    tenant_id: string
    mfa_enabled: boolean
    must_change_password: boolean
  }>(
    "select id, email, full_name, role, status, tenant_id, mfa_enabled, must_change_password from users where id = $1",
    [userId]
  )
  if (!u || u.status !== "active") return null
  return buildActor({ ...u, user_id: u.id, session_id: sessionId, mfa_pending: false, last_seen_at: new Date() }, tenantOverride)
}

async function buildActor(row: SessionRow, tenantOverride?: string | null): Promise<Actor | null> {
  const isSuperadmin = row.role === "superadmin"
  let tenantId = row.tenant_id
  if (isSuperadmin && tenantOverride && tenantOverride !== tenantId) {
    const exists = await q1("select 1 from tenants where id = $1", [tenantOverride])
    if (exists) tenantId = tenantOverride
  }
  const tenant = await loadTenant(tenantId)
  if (!tenant) return null
  // a suspended tenant's people cannot sign in or use the API (super admins can still manage it)
  if (tenant.status === "suspended" && !isSuperadmin) return null

  let customPerms: string[] | null = null
  let roleName: string = row.role
  if (isSystemRole(row.role)) {
    roleName = SYSTEM_ROLES[row.role].name
  } else {
    const r = await q1<{ name: string; permissions: string[] }>(
      "select name, permissions from custom_roles where tenant_id = $1 and key = $2",
      [row.tenant_id, row.role]
    )
    customPerms = r?.permissions ?? []
    roleName = r?.name ?? row.role
  }
  const groups = await q<{ group_id: string }>(
    `select gm.group_id from group_members gm join groups g on g.id = gm.group_id
      where gm.user_id = $1 and g.tenant_id = $2 and g.is_active`,
    [row.user_id, tenantId]
  )
  return {
    id: row.user_id,
    email: row.email,
    name: row.full_name || row.email,
    role: row.role,
    roleName,
    tenantId,
    homeTenantId: row.tenant_id,
    tenant,
    permissions: permissionsFor(row.role, customPerms),
    groupIds: groups.map((g) => g.group_id),
    isSuperadmin,
    mfaEnabled: row.mfa_enabled,
    mustChangePassword: row.must_change_password,
    sessionId: row.session_id,
  }
}

type Session = { actor: Actor; mfaPending: boolean }

/** The signed-in session for this request (cached per request). */
export const getSession = cache(async (): Promise<Session | null> => {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token || token.length > 200) return null
  const row = await q1<SessionRow>(
    `select s.id as session_id, s.mfa_pending, s.last_seen_at, u.id as user_id, u.email, u.full_name, u.role,
            u.status, u.tenant_id, u.mfa_enabled, u.must_change_password
       from sessions s join users u on u.id = s.user_id
      where s.id = $1 and s.expires_at > now()`,
    [sha256Hex(token)]
  )
  if (!row || row.status !== "active") return null
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await exec("update sessions set last_seen_at = now() where id = $1", [row.session_id])
    await exec("update users set last_seen_at = now() where id = $1", [row.user_id])
  }
  const actor = await buildActor(row, store.get(TENANT_COOKIE)?.value)
  if (!actor) return null
  return { actor, mfaPending: row.mfa_pending }
})

/** The fully signed-in actor (MFA done), or null. */
export async function currentActor(): Promise<Actor | null> {
  const s = await getSession()
  if (!s || s.mfaPending) return null
  return s.actor
}

/** For pages and server actions: the actor, or a redirect to sign-in. */
export async function requireActor(): Promise<Actor> {
  const s = await getSession()
  if (!s) redirect("/login")
  if (s.mfaPending) redirect("/login/mfa")
  // enforced here (not only in the layout) so no page renders before these steps are done
  if (s.actor.mustChangePassword) redirect("/account/password")
  if (s.actor.tenant.requireMfa && !s.actor.mfaEnabled) redirect("/account/mfa")
  return s.actor
}

export async function requirePermission(perm: Permission): Promise<Actor> {
  const actor = await requireActor()
  if (!actor.permissions.has(perm)) redirect("/denied")
  return actor
}

export async function requireAnyPermission(perms: Permission[]): Promise<Actor> {
  const actor = await requireActor()
  if (!perms.some((p) => actor.permissions.has(p))) redirect("/denied")
  return actor
}

/** Creates a session and sets the cookie (server actions / route handlers only). */
export async function startSession(userId: string, opts: { mfaPending: boolean; hours: number }): Promise<void> {
  const token = randomToken(32)
  const h = await headers()
  await exec(
    `insert into sessions (id, user_id, mfa_pending, expires_at, ip, user_agent)
     values ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)`,
    [sha256Hex(token), userId, opts.mfaPending, opts.hours, await clientIp(), (h.get("user-agent") ?? "").slice(0, 300)]
  )
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure(),
    path: "/",
    maxAge: opts.hours * 3600,
  })
}

export async function completeMfa(sessionId: string): Promise<void> {
  await exec("update sessions set mfa_pending = false where id = $1", [sessionId])
}

export async function endSession(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token) await exec("delete from sessions where id = $1", [sha256Hex(token)])
  store.delete(SESSION_COOKIE)
  store.delete(TENANT_COOKIE)
}

/** Signs a user out everywhere (password change, disable, role change). */
export async function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  if (exceptSessionId) await exec("delete from sessions where user_id = $1 and id <> $2", [userId, exceptSessionId])
  else await exec("delete from sessions where user_id = $1", [userId])
}
