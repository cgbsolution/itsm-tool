/**
 * Tenant management for super administrators: list, create (with an invited
 * first administrator), suspend / activate, and switching the tenant a super
 * admin works in (the TENANT_COOKIE override read by the session).
 */
import { cookies } from "next/headers"
import { q, q1, tx, exec, isUuid, isUniqueViolation } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { TENANT_COOKIE } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { createTenant, slugify } from "@/lib/tenants"
import { randomToken, sha256Hex } from "@/lib/crypto"
import { queueEmail } from "@/lib/email/send"
import { config } from "@/lib/config"
import { AppError, forbidden, notFound } from "@/lib/errors"
import { need, auditActor, requestIp } from "@/lib/sysadmin/guard"
import { tenantInputFrom, SLUG_RE } from "@/lib/sysadmin/validate"

export const INVITE_HOURS = 72

function superOnly(actor: Actor) {
  need(actor, "admin.tenants")
  if (!actor.isSuperadmin) throw forbidden()
}

export type TenantRow = {
  id: string
  name: string
  slug: string
  status: "active" | "suspended"
  created_at: Date
  users: number
  tickets: number
}

export async function listTenants(actor: Actor): Promise<TenantRow[]> {
  superOnly(actor)
  return q<TenantRow>(
    `select t.id, t.name, t.slug, t.status, t.created_at,
            (select count(*) from users u where u.tenant_id = t.id) as users,
            (select count(*) from tickets k where k.tenant_id = t.id) as tickets
       from tenants t
      order by lower(t.name)`
  )
}

export async function createTenantWithAdmin(actor: Actor, input: Record<string, unknown>): Promise<{ tenantId: string; slug: string }> {
  superOnly(actor)
  const t = tenantInputFrom(input)
  const slug = t.slug ?? slugify(t.name)
  if (!SLUG_RE.test(slug)) throw new AppError("Choose a slug: 2–63 lowercase letters, digits or hyphens")
  const ip = await requestIp()
  try {
    return await tx(async (db) => {
      if (await q1("select 1 from tenants where slug = $1", [slug], db)) throw new AppError(`The slug "${slug}" is already used by another tenant`)
      if (await q1("select 1 from users where lower(email) = $1", [t.adminEmail], db)) throw new AppError("A user with that email already exists (emails are unique across tenants)")
      const tenantId = await createTenant(t.name, { slug, timezone: t.timezone }, db)
      const user = await q1<{ id: string }>(
        `insert into users (tenant_id, email, full_name, role, status, auth_source)
         values ($1, $2, $3, 'admin', 'invited', 'local') returning id`,
        [tenantId, t.adminEmail, t.adminName],
        db
      )
      const token = randomToken(32)
      await exec(
        "insert into auth_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, 'invite', now() + make_interval(hours => $3))",
        [sha256Hex(token), user!.id, INVITE_HOURS],
        db
      )
      await queueEmail(
        {
          tenantId,
          to: t.adminEmail,
          template: "user.invite",
          vars: { link: `${config.appUrl()}/reset/${token}`, hours: INVITE_HOURS, recipient: { name: t.adminName } },
          relatedType: "user",
          relatedId: user!.id,
        },
        db
      )
      await audit(
        {
          tenantId,
          actor: auditActor(actor),
          action: "admin.tenant_created",
          entityType: "tenant",
          entityId: tenantId,
          summary: `Tenant "${t.name}" created; ${t.adminEmail} invited as administrator`,
          data: { name: t.name, slug, timezone: t.timezone, admin_user_id: user!.id, admin_email: t.adminEmail },
          ip,
        },
        db
      )
      return { tenantId, slug }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("That slug or administrator email is already in use")
    throw err
  }
}

export async function setTenantStatus(actor: Actor, tenantId: string, status: "active" | "suspended"): Promise<void> {
  superOnly(actor)
  if (!isUuid(tenantId)) throw notFound("Tenant not found")
  if (status !== "active" && status !== "suspended") throw new AppError("Unknown status")
  if (status === "suspended" && tenantId === actor.homeTenantId) throw new AppError("You cannot suspend your own tenant")
  const ip = await requestIp()
  await tx(async (db) => {
    const row = await q1<{ name: string }>("update tenants set status = $2 where id = $1 and status <> $2 returning name", [tenantId, status], db)
    if (!row) throw new AppError(`The tenant is already ${status} or does not exist`, 409)
    await audit(
      {
        tenantId,
        actor: auditActor(actor),
        action: status === "suspended" ? "admin.tenant_suspended" : "admin.tenant_activated",
        entityType: "tenant",
        entityId: tenantId,
        summary: `Tenant "${row.name}" ${status === "suspended" ? "suspended" : "activated"}`,
        ip,
      },
      db
    )
  })
}

/** Makes the super admin work in another tenant until they switch back. */
export async function switchTenant(actor: Actor, tenantId: string): Promise<string> {
  superOnly(actor)
  if (!isUuid(tenantId)) throw notFound("Tenant not found")
  const t = await q1<{ id: string; name: string }>("select id, name from tenants where id = $1", [tenantId])
  if (!t) throw notFound("Tenant not found")
  const store = await cookies()
  if (t.id === actor.homeTenantId) {
    store.delete(TENANT_COOKIE)
  } else {
    store.set(TENANT_COOKIE, t.id, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure(), path: "/" })
  }
  await audit({
    tenantId: t.id,
    actor: auditActor(actor),
    action: "admin.tenant_switched",
    entityType: "tenant",
    entityId: t.id,
    summary: `Switched to tenant "${t.name}"`,
    data: { from_tenant_id: actor.tenantId, home_tenant_id: actor.homeTenantId },
    ip: await requestIp(),
  })
  return t.name
}

/** Back to the super admin's own tenant. */
export async function switchBack(actor: Actor): Promise<void> {
  superOnly(actor)
  const store = await cookies()
  store.delete(TENANT_COOKIE)
  await audit({
    tenantId: actor.tenantId,
    actor: auditActor(actor),
    action: "admin.tenant_switched_back",
    entityType: "tenant",
    entityId: actor.tenantId,
    summary: `Left tenant "${actor.tenant.name}" for the home tenant`,
    data: { from_tenant_id: actor.tenantId, home_tenant_id: actor.homeTenantId },
    ip: await requestIp(),
  })
}
