/** Read side of the CMDB: lists with filters, export rows, the detail view, impact analysis. */
import { q, q1, Params, pool, isUuid, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { forbidden, notFound } from "@/lib/errors"
import { readSchema } from "@/lib/cmdb/attributes"
import { CI_COLUMNS, type CiRow, type ClassRow } from "@/lib/cmdb/service"
import { DEPENDENCY_TYPES, IMPACT_MAX_DEPTH, REVERSED_DEPENDENCY_TYPES, isCiStatus } from "@/lib/cmdb/vocab"
import { todayIn } from "@/lib/cmdb/values"

function requireView(actor: Actor) {
  if (!actor.permissions.has("cmdb.view")) throw forbidden("You cannot view the CMDB")
}

export type CiFilters = {
  q?: string
  class?: string // class key
  status?: string // <status> | active (not retired/disposed)
  owner?: string // me | none | any
  location?: string
  warranty?: string // expired | expiring
  sort?: string // code | name | updated | warranty
  page?: number
  pageSize?: number
}

/** Filters from URL search params (list page and export share this). */
export function filtersFromParams(sp: URLSearchParams | Record<string, string | undefined>): CiFilters {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) ?? undefined : sp[k]) || undefined
  return {
    q: get("q"),
    class: get("class"),
    status: get("status"),
    owner: get("owner"),
    location: get("location"),
    warranty: get("warranty"),
    sort: get("sort"),
    page: Number(get("page")) || 1,
  }
}

function likeParam(p: Params, text: string) {
  return p.add(`%${text.replace(/[\\%_]/g, (c) => "\\" + c)}%`)
}

function buildWhere(actor: Actor, f: CiFilters, p: Params): string[] {
  const where = [`c.tenant_id = ${p.add(actor.tenantId)}`]
  const text = f.q?.trim().slice(0, 200)
  if (text) {
    const like = likeParam(p, text)
    where.push(`(c.search @@ plainto_tsquery('simple', ${p.add(text)}) or c.ci_code ilike ${like} or c.serial_no ilike ${like} or c.name ilike ${like})`)
  }
  if (f.class && /^[a-z][a-z0-9_]{0,40}$/.test(f.class)) where.push(`cl.key = ${p.add(f.class)}`)
  if (f.status === "active") where.push("c.status not in ('retired', 'disposed')")
  else if (isCiStatus(f.status)) where.push(`c.status = ${p.add(f.status)}`)
  if (f.owner === "me") where.push(`c.owner_id = ${p.add(actor.id)}::uuid`)
  else if (f.owner === "none") where.push("c.owner_id is null")
  const loc = f.location?.trim().slice(0, 200)
  if (loc) where.push(`c.location ilike ${likeParam(p, loc)}`)
  if (f.warranty === "expired" || f.warranty === "expiring") {
    const today = p.add(todayIn(actor.tenant.timezone))
    if (f.warranty === "expired") where.push(`c.warranty_expiry < ${today}::date`)
    else where.push(`c.warranty_expiry between ${today}::date and ${today}::date + 30`)
  }
  return where
}

function orderBy(sort?: string) {
  if (sort === "name") return "c.name, c.ci_code"
  if (sort === "updated") return "c.updated_at desc"
  if (sort === "warranty") return "c.warranty_expiry asc nulls last, c.ci_code"
  return "upper(c.ci_code)"
}

export type CiListRow = {
  id: string
  ci_code: string
  name: string
  status: string
  class_key: string
  class_name: string
  owner_name: string | null
  owner_email: string | null
  location: string | null
  room: string | null
  warranty_expiry: string | null
  serial_no: string | null
  source: string
  updated_at: Date
  total: number
}

export async function listCis(actor: Actor, f: CiFilters): Promise<{ rows: CiListRow[]; total: number; page: number; pageSize: number }> {
  requireView(actor)
  const p = new Params()
  const where = buildWhere(actor, f, p)
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 5), 200)
  const page = Math.min(Math.max(f.page ?? 1, 1), 100_000)
  const rows = await q<CiListRow>(
    `select c.id, c.ci_code, c.name, c.status, cl.key as class_key, cl.name as class_name, u.full_name as owner_name, u.email as owner_email,
            c.location, c.room, c.warranty_expiry, c.serial_no, c.source, c.updated_at, count(*) over () as total
       from configuration_items c
       join ci_classes cl on cl.id = c.class_id
       left join users u on u.id = c.owner_id
      where ${where.join(" and ")}
      order by ${orderBy(f.sort)}
      limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export const EXPORT_MAX_ROWS = 50_000

const EXPORT_BASE_HEADER = [
  "ci_code", "name", "class", "class_name", "status", "condition", "environment", "criticality", "owner_email", "owner_name",
  "support_group", "organization", "location", "room", "department", "manufacturer", "model", "serial_no", "purchase_date",
  "warranty_years", "warranty_expiry", "cost", "notes", "source", "last_seen_at", "created_at", "updated_at",
]

/** CSV header and rows for the export (attributes become one column each). */
export async function exportCis(actor: Actor, f: CiFilters): Promise<{ header: string[]; rows: unknown[][] }> {
  requireView(actor)
  const p = new Params()
  const where = buildWhere(actor, f, p)
  const rows = await q<Record<string, unknown> & { attributes: Record<string, unknown> | null }>(
    `select c.ci_code, c.name, cl.key as class, cl.name as class_name, c.status, c.condition, c.environment, c.criticality,
            u.email as owner_email, u.full_name as owner_name, g.name as support_group, o.name as organization,
            c.location, c.room, c.department, c.manufacturer, c.model, c.serial_no, c.purchase_date, c.warranty_years,
            c.warranty_expiry, c.cost, c.notes, c.source, c.last_seen_at, c.created_at, c.updated_at, c.attributes
       from configuration_items c
       join ci_classes cl on cl.id = c.class_id
       left join users u on u.id = c.owner_id
       left join groups g on g.id = c.support_group_id
       left join organizations o on o.id = c.organization_id
      where ${where.join(" and ")}
      order by ${orderBy(f.sort)}
      limit ${EXPORT_MAX_ROWS}`,
    p.values
  )
  const attrKeys = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r.attributes ?? {})) attrKeys.add(k)
  const base = new Set(EXPORT_BASE_HEADER)
  const keys = [...attrKeys].sort()
  const header = [...EXPORT_BASE_HEADER, ...keys.map((k) => (base.has(k) ? `attributes_${k}` : k))]
  return {
    header,
    rows: rows.map((r) => [...EXPORT_BASE_HEADER.map((h) => r[h]), ...keys.map((k) => r.attributes?.[k] ?? null)]),
  }
}

/* ── detail ────────────────────────────────────────────────────────────── */

export type CiDetailRow = CiRow & {
  class_key: string
  class_name: string
  class_category: string
  class_active: boolean
  class_attributes: unknown
  owner_name: string | null
  owner_email: string | null
  support_group_name: string | null
  organization_name: string | null
}

export type RelationshipRow = { id: string; rel_type: string; other_id: string; other_code: string; other_name: string; other_status: string; other_class: string }
export type WalkRow = { id: string; ci_code: string; name: string; status: string; class_name: string; depth: number; via: string; path: string }

async function walk(db: Db, tenantId: string, ciId: string, direction: "impact" | "depends", limit = 500): Promise<WalkRow[]> {
  // impact: who needs this CI (follow edges against their direction); depends: what this CI needs.
  // A "needs" edge is (source → target) for DEPENDENCY_TYPES and (target → source) for contains.
  // Written as two index-friendly branches rather than a CASE on both columns.
  const needer = (r: string) => `case when ${r}.rel_type = any($4::text[]) then ${r}.target_id else ${r}.source_id end`
  const needed = (r: string) => `case when ${r}.rel_type = any($4::text[]) then ${r}.source_id else ${r}.target_id end`
  const to = direction === "impact" ? needer : needed
  const [fwd, rev] = direction === "impact" ? ["target_id", "source_id"] : ["source_id", "target_id"]
  const edge = (r: string, at: string) =>
    `${r}.tenant_id = $1 and ((${r}.rel_type = any($3::text[]) and ${r}.${fwd} = ${at}) or (${r}.rel_type = any($4::text[]) and ${r}.${rev} = ${at}))`
  return q<WalkRow>(
    `with recursive walk (ci_id, depth, path, via) as (
       select ${to("r")}, 1, array[$2::uuid, ${to("r")}], r.rel_type
         from ci_relationships r
        where ${edge("r", "$2::uuid")}
       union all
       select ${to("r")}, w.depth + 1, w.path || ${to("r")}, r.rel_type
         from walk w
         join ci_relationships r on ${edge("r", "w.ci_id")}
        where w.depth < $5 and not (${to("r")} = any(w.path))
     ),
     best as (
       select distinct on (ci_id) ci_id, depth, path, via from walk order by ci_id, depth
     )
     select c.id, c.ci_code, c.name, c.status, cl.name as class_name, b.depth, b.via,
            (select string_agg(x.ci_code, ' → ' order by u.ord)
               from unnest(b.path) with ordinality u(id, ord) join configuration_items x on x.id = u.id and x.tenant_id = $1) as path
       from best b
       join configuration_items c on c.id = b.ci_id and c.tenant_id = $1
       join ci_classes cl on cl.id = c.class_id
      order by b.depth, upper(c.ci_code)
      limit ${limit}`,
    [tenantId, ciId, DEPENDENCY_TYPES, REVERSED_DEPENDENCY_TYPES, IMPACT_MAX_DEPTH],
    db
  )
}

export async function impactOf(actor: Actor, ciId: string, db: Db = pool()) {
  requireView(actor)
  return walk(db, actor.tenantId, ciId, "impact")
}

export async function dependenciesOf(actor: Actor, ciId: string, db: Db = pool()) {
  requireView(actor)
  return walk(db, actor.tenantId, ciId, "depends")
}

export type CiDetail = Awaited<ReturnType<typeof getCiDetail>>

export async function getCiDetail(actor: Actor, id: string, db: Db = pool()) {
  requireView(actor)
  if (!isUuid(id)) throw notFound("Configuration item not found")
  const ci = await q1<CiDetailRow>(
    `select ${CI_COLUMNS.split(",").map((c) => `c.${c.trim()}`).join(", ")},
            cl.key as class_key, cl.name as class_name, cl.category as class_category, cl.is_active as class_active, cl.attributes as class_attributes,
            u.full_name as owner_name, u.email as owner_email, g.name as support_group_name, o.name as organization_name
       from configuration_items c
       join ci_classes cl on cl.id = c.class_id
       left join users u on u.id = c.owner_id
       left join groups g on g.id = c.support_group_id
       left join organizations o on o.id = c.organization_id
      where c.id = $1 and c.tenant_id = $2`,
    [id, actor.tenantId],
    db
  )
  if (!ci) throw notFound("Configuration item not found")
  const t = actor.tenantId
  const canSeeTickets = actor.permissions.has("ticket.view_all")
  const [outgoing, incoming, impact, dependsOn, tickets, ticketCount, assignments, history, devices] = await Promise.all([
    q<RelationshipRow>(
      `select r.id, r.rel_type, o.id as other_id, o.ci_code as other_code, o.name as other_name, o.status as other_status, cl.name as other_class
         from ci_relationships r join configuration_items o on o.id = r.target_id and o.tenant_id = $2 join ci_classes cl on cl.id = o.class_id
        where r.source_id = $1 and r.tenant_id = $2 order by r.rel_type, upper(o.ci_code)`,
      [ci.id, t],
      db
    ),
    q<RelationshipRow>(
      `select r.id, r.rel_type, o.id as other_id, o.ci_code as other_code, o.name as other_name, o.status as other_status, cl.name as other_class
         from ci_relationships r join configuration_items o on o.id = r.source_id and o.tenant_id = $2 join ci_classes cl on cl.id = o.class_id
        where r.target_id = $1 and r.tenant_id = $2 order by r.rel_type, upper(o.ci_code)`,
      [ci.id, t],
      db
    ),
    walk(db, t, ci.id, "impact"),
    walk(db, t, ci.id, "depends"),
    canSeeTickets
      ? q<{ id: string; number: string; subject: string; status: string; ticket_type: string; priority: string; role: string; created_at: Date }>(
          `select tk.id, tk.number, tk.subject, tk.status, tk.ticket_type, tk.priority, tc.role, tk.created_at
             from ticket_cis tc join tickets tk on tk.id = tc.ticket_id and tk.tenant_id = $2
            where tc.ci_id = $1 order by tk.created_at desc limit 100`,
          [ci.id, t],
          db
        )
      : Promise.resolve([]),
    q1<{ n: number }>("select count(*) as n from ticket_cis tc join tickets tk on tk.id = tc.ticket_id and tk.tenant_id = $2 where tc.ci_id = $1", [ci.id, t], db),
    q<{ id: string; user_name: string | null; user_email: string; assigned_by_name: string | null; assigned_at: Date; returned_at: Date | null; note: string | null }>(
      `select a.id, u.full_name as user_name, u.email as user_email, b.full_name as assigned_by_name, a.assigned_at, a.returned_at, a.note
         from ci_assignments a join users u on u.id = a.user_id left join users b on b.id = a.assigned_by
        where a.ci_id = $1 and a.tenant_id = $2 order by a.assigned_at desc limit 100`,
      [ci.id, t],
      db
    ),
    q<{ id: string; action: string; changes: Record<string, { from: unknown; to: unknown }> | null; created_at: Date; actor_name: string | null }>(
      `select h.id, h.action, h.changes, h.created_at, u.full_name as actor_name
         from ci_history h left join users u on u.id = h.actor_id
        where h.ci_id = $1 and h.tenant_id = $2 order by h.created_at desc limit 200`,
      [ci.id, t],
      db
    ),
    q<{ id: string; hostname: string; os_name: string | null; status: string; last_seen_at: Date | null }>(
      "select id, hostname, os_name, status, last_seen_at from devices where ci_id = $1 and tenant_id = $2 order by last_seen_at desc nulls last limit 5",
      [ci.id, t],
      db
    ),
  ])
  return {
    ci,
    schema: readSchema(ci.class_attributes),
    outgoing,
    incoming,
    impact,
    dependsOn,
    tickets,
    ticketCount: ticketCount?.n ?? 0,
    canSeeTickets,
    assignments,
    openAssignment: assignments.find((a) => !a.returned_at) ?? null,
    history,
    devices,
  }
}

/* ── classes and pickers ───────────────────────────────────────────────── */

export type ClassListRow = ClassRow & { ci_count: number }

export async function listClasses(actor: Actor, opts: { activeOnly?: boolean } = {}): Promise<ClassListRow[]> {
  requireView(actor)
  const rows = await q<ClassListRow>(
    `select cl.*, (select count(*) from configuration_items c where c.tenant_id = cl.tenant_id and c.class_id = cl.id) as ci_count
       from ci_classes cl
      where cl.tenant_id = $1 ${opts.activeOnly ? "and cl.is_active" : ""}
      order by cl.category, cl.name`,
    [actor.tenantId]
  )
  return rows.map((r) => ({ ...r, attributes: readSchema(r.attributes) }))
}

export async function getClass(actor: Actor, idOrKey: string): Promise<ClassListRow | null> {
  requireView(actor)
  const byId = isUuid(idOrKey)
  if (!byId && !/^[a-z][a-z0-9_]{0,40}$/.test(idOrKey)) return null
  const row = await q1<ClassListRow>(
    `select cl.*, (select count(*) from configuration_items c where c.tenant_id = cl.tenant_id and c.class_id = cl.id) as ci_count
       from ci_classes cl where cl.tenant_id = $1 and ${byId ? "cl.id = $2" : "cl.key = $2"}`,
    [actor.tenantId, idOrKey]
  )
  return row ? { ...row, attributes: readSchema(row.attributes) } : null
}

export async function ciFormOptions(tenantId: string) {
  const [users, groups, organizations] = await Promise.all([
    q<{ id: string; full_name: string; email: string }>(
      "select id, full_name, email from users where tenant_id = $1 and status = 'active' order by full_name, email limit 2000",
      [tenantId]
    ),
    q<{ id: string; name: string }>("select id, name from groups where tenant_id = $1 and is_active order by name", [tenantId]),
    q<{ id: string; name: string }>("select id, name from organizations where tenant_id = $1 and status = 'active' order by name", [tenantId]),
  ])
  return { users, groups, organizations }
}

export async function locationOptions(tenantId: string): Promise<string[]> {
  const rows = await q<{ location: string }>(
    "select distinct location from configuration_items where tenant_id = $1 and location is not null order by location limit 300",
    [tenantId]
  )
  return rows.map((r) => r.location)
}
