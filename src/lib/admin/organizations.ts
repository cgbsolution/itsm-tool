/**
 * Organisations: client companies inside a tenant (a label on users,
 * tickets and CIs; not an access boundary). Requires admin.users.
 */
import { q, q1, exec, tx, isUuid, isUniqueViolation } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { optionalDomain, requiredText } from "@/lib/admin/rules"

export type OrganizationRow = {
  id: string
  name: string
  domain: string | null
  status: "active" | "inactive"
  user_count: number
  ticket_count: number
  created_at: Date
}

const SELECT = `
  select o.id, o.name, o.domain, o.status, o.created_at,
         (select count(*) from users u where u.organization_id = o.id) as user_count,
         (select count(*) from tickets t where t.organization_id = o.id and t.tenant_id = o.tenant_id) as ticket_count
    from organizations o`

export async function listOrganizations(actor: Actor, opts: { q?: string } = {}): Promise<OrganizationRow[]> {
  assertPermission(actor, "admin.users")
  const text = opts.q?.trim()
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => "\\" + c)}%`
    return q<OrganizationRow>(`${SELECT} where o.tenant_id = $1 and (o.name ilike $2 or o.domain ilike $2) order by lower(o.name)`, [actor.tenantId, like])
  }
  return q<OrganizationRow>(`${SELECT} where o.tenant_id = $1 order by o.status, lower(o.name)`, [actor.tenantId])
}

export async function getOrganization(actor: Actor, id: string): Promise<OrganizationRow> {
  assertPermission(actor, "admin.users")
  if (!isUuid(id)) throw notFound("Organisation not found")
  const o = await q1<OrganizationRow>(`${SELECT} where o.tenant_id = $1 and o.id = $2`, [actor.tenantId, id])
  if (!o) throw notFound("Organisation not found")
  return o
}

/** Organisations for selects. */
export async function organizationOptions(actor: Actor) {
  return q<{ id: string; name: string; status: string }>("select id, name, status from organizations where tenant_id = $1 order by lower(name)", [actor.tenantId])
}

export type OrganizationInput = { name: unknown; domain?: unknown; status?: unknown }

function parse(input: OrganizationInput) {
  const status = String(input.status ?? "active")
  if (status !== "active" && status !== "inactive") throw new AppError("Choose a status")
  return { name: requiredText(input.name, 200, "Name"), domain: optionalDomain(input.domain), status }
}

function friendly(e: unknown): never {
  if (isUniqueViolation(e, "organizations_tenant_name_key")) throw new AppError("An organisation with that name already exists")
  throw e
}

export async function createOrganization(actor: Actor, input: OrganizationInput): Promise<string> {
  assertPermission(actor, "admin.users")
  const o = parse(input)
  try {
    return await tx(async (db) => {
      const row = await q1<{ id: string }>("insert into organizations (tenant_id, name, domain, status) values ($1, $2, $3, $4) returning id", [actor.tenantId, o.name, o.domain, o.status], db)
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.organization_created", entityType: "organization", entityId: row!.id, summary: `Organisation ${o.name} created`, data: o },
        db
      )
      return row!.id
    })
  } catch (e) {
    friendly(e)
  }
}

export async function updateOrganization(actor: Actor, id: string, input: OrganizationInput): Promise<void> {
  assertPermission(actor, "admin.users")
  if (!isUuid(id)) throw notFound("Organisation not found")
  const o = parse(input)
  try {
    await tx(async (db) => {
      const before = await q1<{ name: string; domain: string | null; status: string }>(
        "select name, domain, status from organizations where id = $1 and tenant_id = $2 for update",
        [id, actor.tenantId],
        db
      )
      if (!before) throw notFound("Organisation not found")
      const changed = (Object.keys(o) as (keyof typeof o)[]).filter((k) => (before[k] ?? null) !== (o[k] ?? null))
      if (!changed.length) return
      await exec("update organizations set name = $3, domain = $4, status = $5 where id = $1 and tenant_id = $2", [id, actor.tenantId, o.name, o.domain, o.status], db)
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: "admin.organization_updated",
          entityType: "organization",
          entityId: id,
          summary: `Organisation ${o.name} changed: ${changed.join(", ")}`,
          data: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: o[k] }])),
        },
        db
      )
    })
  } catch (e) {
    friendly(e)
  }
}

/** Deletes an organisation. Users, tickets and CIs keep existing without one. */
export async function deleteOrganization(actor: Actor, id: string): Promise<void> {
  assertPermission(actor, "admin.users")
  if (!isUuid(id)) throw notFound("Organisation not found")
  await tx(async (db) => {
    const o = await q1<{ name: string }>("select name from organizations where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], db)
    if (!o) throw notFound("Organisation not found")
    const users = await q1<{ n: number }>("select count(*) as n from users where organization_id = $1", [id], db)
    const tickets = await q1<{ n: number }>("select count(*) as n from tickets where organization_id = $1 and tenant_id = $2", [id, actor.tenantId], db)
    await exec("delete from organizations where id = $1 and tenant_id = $2", [id, actor.tenantId], db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.organization_deleted",
        entityType: "organization",
        entityId: id,
        summary: `Organisation ${o.name} deleted`,
        data: { name: o.name, users_unlinked: users!.n, tickets_unlinked: tickets!.n },
      },
      db
    )
  })
}
