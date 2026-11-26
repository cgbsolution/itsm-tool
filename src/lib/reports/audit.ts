/**
 * Read side of the audit log. A super administrator sees every tenant's rows
 * and system rows (tenant_id null); everyone else only their tenant's.
 */
import { q, Params, isUuid, pool } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { audit, verifyAuditChain } from "@/lib/audit"
import { forbidden } from "@/lib/errors"
import { addDays, dayStart, isYmd } from "@/lib/reports/helpers"

export type AuditFilters = {
  action?: string
  actor?: string
  entityType?: string
  entityId?: string
  from?: string
  to?: string
  /** super admin only: "" (all), "system" (no tenant) or a tenant id */
  tenant?: string
  page?: number
}

export type AuditRow = {
  id: number
  tenant_id: string | null
  tenant_name: string | null
  actor_id: string | null
  actor_label: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  summary: string | null
  data: Record<string, unknown> | null
  ip: string | null
  created_at: Date
  total: number
}

function likeEscape(s: string) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c)
}

function need(actor: Actor) {
  if (!actor.permissions.has("audit.view")) throw forbidden()
}

function whereFor(actor: Actor, f: AuditFilters) {
  const p = new Params()
  const where: string[] = []
  if (!actor.isSuperadmin) {
    where.push(`a.tenant_id = ${p.add(actor.tenantId)}`)
  } else if (f.tenant === "system") {
    where.push("a.tenant_id is null")
  } else if (f.tenant && isUuid(f.tenant)) {
    where.push(`a.tenant_id = ${p.add(f.tenant)}`)
  }
  const action = f.action?.trim()
  if (action) where.push(`a.action like ${p.add(likeEscape(action.slice(0, 100)) + "%")}`)
  const who = f.actor?.trim()
  if (who) where.push(`a.actor_label ilike ${p.add("%" + likeEscape(who.slice(0, 200)) + "%")}`)
  const et = f.entityType?.trim()
  if (et) where.push(`a.entity_type = ${p.add(et.slice(0, 100))}`)
  const eid = f.entityId?.trim()
  if (eid) where.push(`a.entity_id = ${p.add(eid.slice(0, 200))}`)
  const tz = actor.tenant.timezone
  if (isYmd(f.from)) where.push(`a.created_at >= ${p.add(dayStart(f.from, tz))}`)
  if (isYmd(f.to)) where.push(`a.created_at < ${p.add(dayStart(addDays(f.to, 1), tz))}`)
  return { p, where: where.length ? `where ${where.join(" and ")}` : "" }
}

const SELECT = `select a.id, a.tenant_id, tn.name as tenant_name, a.actor_id, a.actor_label, a.action, a.entity_type, a.entity_id,
                       a.summary, a.data, a.ip, a.created_at`

export async function listAudit(actor: Actor, f: AuditFilters, pageSize = 50) {
  need(actor)
  const { p, where } = whereFor(actor, f)
  const page = Math.max(1, Math.min(f.page ?? 1, 10_000))
  const rows = await q<AuditRow>(
    `${SELECT}, count(*) over () as total
       from audit_log a left join tenants tn on tn.id = a.tenant_id
     ${where}
     order by a.id desc
     limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export const AUDIT_EXPORT_LIMIT = 50_000

export async function exportAudit(actor: Actor, f: AuditFilters) {
  need(actor)
  const { p, where } = whereFor(actor, f)
  const rows = await q<Omit<AuditRow, "total">>(
    `${SELECT}
       from audit_log a left join tenants tn on tn.id = a.tenant_id
     ${where}
     order by a.id desc
     limit ${AUDIT_EXPORT_LIMIT}`,
    p.values
  )
  await audit({
    tenantId: actor.tenantId,
    actor: { id: actor.id, email: actor.email },
    action: "audit.exported",
    entityType: "audit_log",
    summary: `Exported ${rows.length} audit entries`,
    data: { filters: { ...f, page: undefined }, rows: rows.length },
  })
  return rows
}

/** Recomputes the whole hash chain (all tenants: there is one chain). */
export async function verifyAudit(actor: Actor) {
  need(actor)
  const result = await verifyAuditChain(pool())
  await audit({
    tenantId: actor.tenantId,
    actor: { id: actor.id, email: actor.email },
    action: "audit.verified",
    entityType: "audit_log",
    summary: result.brokenAt === null ? `Audit chain intact (${result.checked} entries)` : `Audit chain broken at entry #${result.brokenAt}`,
    data: result,
  })
  return result
}

/** Distinct entity types and action prefixes (and tenants for a super admin), for the filter pickers. */
export async function auditFacets(actor: Actor) {
  need(actor)
  const scope = actor.isSuperadmin ? "" : "where tenant_id = $1"
  const params = actor.isSuperadmin ? [] : [actor.tenantId]
  const [types, prefixes, tenants] = await Promise.all([
    q<{ v: string }>(`select distinct entity_type as v from audit_log ${scope ? scope + " and" : "where"} entity_type is not null order by 1 limit 100`, params),
    q<{ v: string }>(`select distinct split_part(action, '.', 1) as v from audit_log ${scope} order by 1 limit 100`, params),
    actor.isSuperadmin ? q<{ id: string; name: string }>("select id, name from tenants order by lower(name)") : Promise.resolve([]),
  ])
  return { entityTypes: types.map((r) => r.v), actionPrefixes: prefixes.map((r) => r.v), tenants }
}
