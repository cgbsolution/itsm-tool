/** Read side of tickets: lists with filters, and the detail view. */
import { q, q1, Params, pool, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { notFound } from "@/lib/errors"
import { accessFor, type TicketRow } from "@/lib/itsm/tickets"
import { loadItsmConfig } from "@/lib/itsm/config"
import { clocksForTicket } from "@/lib/itsm/sla"
import { approvalsForTicket } from "@/lib/itsm/approvals"
import { STATE_CATEGORY, STATUSES, type Status } from "@/lib/itsm/workflow"
import { isTicketType, isPriority, type TicketType } from "@/lib/itsm/vocab"

export type TicketFilters = {
  type?: string
  view?: string // active | resolved | done | all | <status>
  assignee?: string // me | unassigned | <uuid>
  group?: string // mine | <uuid>
  priority?: string
  requester?: string // me | <uuid>
  sla?: string // breached | at_risk
  q?: string
  sort?: string // created | updated | priority | due
  page?: number
  pageSize?: number
}

export type TicketListRow = {
  id: string
  number: string
  ticket_type: TicketType
  status: Status
  subject: string
  priority: string
  category: string | null
  sub_category: string | null
  created_at: Date
  updated_at: Date
  sla_resolution_due: Date | null
  sla_resolution_breached: boolean
  sla_response_breached: boolean
  requester_name: string | null
  assignee_name: string | null
  group_name: string | null
  total: number
}

const UUID = /^[0-9a-f-]{36}$/i

function categoriesFor(view: string): Status[] | null {
  if (view === "active") return STATUSES.filter((s) => ["open", "paused"].includes(STATE_CATEGORY[s]))
  if (view === "resolved") return STATUSES.filter((s) => STATE_CATEGORY[s] === "resolved")
  if (view === "done") return STATUSES.filter((s) => STATE_CATEGORY[s] === "done")
  return null
}

export async function listTickets(actor: Actor, f: TicketFilters): Promise<{ rows: TicketListRow[]; total: number; page: number; pageSize: number }> {
  const p = new Params()
  const where: string[] = [`t.tenant_id = ${p.add(actor.tenantId)}`]
  let meRef: string | null = null
  const me = () => (meRef ??= `${p.add(actor.id)}::uuid`)
  const isStaff = actor.permissions.has("ticket.view_all")
  if (!isStaff) {
    where.push(
      `(t.requester_id = ${me()} or t.assignee_id = ${me()} or t.assignment_group_id = any(${p.add(actor.groupIds)}::uuid[])
        or exists (select 1 from ticket_watchers w where w.ticket_id = t.id and w.user_id = ${me()}))`
    )
  }
  if (f.type && isTicketType(f.type)) where.push(`t.ticket_type = ${p.add(f.type)}`)
  const view = f.view ?? "active"
  const statuses = categoriesFor(view)
  if (statuses) where.push(`t.status = any(${p.add(statuses)}::text[])`)
  else if ((STATUSES as readonly string[]).includes(view)) where.push(`t.status = ${p.add(view)}`)
  if (f.assignee === "me") where.push(`t.assignee_id = ${me()}`)
  else if (f.assignee === "unassigned") where.push("t.assignee_id is null")
  else if (f.assignee && UUID.test(f.assignee)) where.push(`t.assignee_id = ${p.add(f.assignee)}`)
  if (f.group === "mine") where.push(`t.assignment_group_id = any(${p.add(actor.groupIds)}::uuid[])`)
  else if (f.group && UUID.test(f.group)) where.push(`t.assignment_group_id = ${p.add(f.group)}`)
  if (f.priority && isPriority(f.priority)) where.push(`t.priority = ${p.add(f.priority)}`)
  if (f.requester === "me") where.push(`t.requester_id = ${me()}`)
  else if (f.requester && UUID.test(f.requester)) where.push(`t.requester_id = ${p.add(f.requester)}`)
  if (f.sla === "breached") where.push("(t.sla_resolution_breached or t.sla_response_breached)")
  if (f.sla === "at_risk") where.push("not t.sla_resolution_breached and t.sla_resolution_due between now() and now() + interval '2 hours'")
  const text = f.q?.trim()
  if (text) {
    const like = p.add(`%${text.replace(/[\\%_]/g, (c) => "\\" + c)}%`)
    where.push(`(upper(t.number) = upper(${p.add(text)}) or t.search @@ plainto_tsquery('simple', ${p.add(text)}) or t.subject ilike ${like})`)
  }
  const order =
    f.sort === "priority"
      ? "case t.priority when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, t.created_at desc"
      : f.sort === "due"
        ? "t.sla_resolution_due asc nulls last, t.created_at desc"
        : f.sort === "updated"
          ? "t.updated_at desc"
          : "t.created_at desc"
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 5), 200)
  const page = Math.max(f.page ?? 1, 1)
  const rows = await q<TicketListRow>(
    `select t.id, t.number, t.ticket_type, t.status, t.subject, t.priority, t.category, t.sub_category, t.created_at, t.updated_at,
            t.sla_resolution_due, t.sla_resolution_breached, t.sla_response_breached,
            coalesce(r.full_name, t.requester_name) as requester_name, a.full_name as assignee_name, g.name as group_name,
            count(*) over () as total
       from tickets t
       left join users r on r.id = t.requester_id
       left join users a on a.id = t.assignee_id
       left join groups g on g.id = t.assignment_group_id
      where ${where.join(" and ")}
      order by ${order}
      limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export type TicketDetail = Awaited<ReturnType<typeof getTicketDetail>>

export async function getTicketDetail(actor: Actor, number: string, db: Db = pool()) {
  const t = await q1<
    TicketRow & {
      requester_full_name: string | null
      requester_email: string | null
      assignee_name: string | null
      group_name: string | null
      cab_group_name: string | null
      created_by_name: string | null
      catalog_item_name: string | null
      catalog_form_fields: { key: string; label: string; type: string }[] | null
      organization_name: string | null
    }
  >(
    `select t.*, r.full_name as requester_full_name, r.email as requester_email, a.full_name as assignee_name, g.name as group_name,
            cg.name as cab_group_name, cb.full_name as created_by_name, ci.name as catalog_item_name, ci.form_fields as catalog_form_fields, o.name as organization_name
       from tickets t
       left join users r on r.id = t.requester_id
       left join users a on a.id = t.assignee_id
       left join groups g on g.id = t.assignment_group_id
       left join groups cg on cg.id = t.cab_group_id
       left join users cb on cb.id = t.created_by
       left join catalog_items ci on ci.id = t.catalog_item_id
       left join organizations o on o.id = t.organization_id
      where t.tenant_id = $1 and upper(t.number) = upper($2)`,
    [actor.tenantId, number],
    db
  )
  if (!t) throw notFound("Ticket not found")
  const config = await loadItsmConfig(actor.tenantId, db)
  const access = await accessFor(db, actor, t, config)
  if (!access.canView) throw notFound("Ticket not found")

  const [comments, activity, files, links, cis, clocks, approvals, tasks, watchers, kb] = await Promise.all([
    q<{ id: string; body: string; is_internal: boolean; source: string; created_at: Date; author_id: string | null; author_name: string | null; author_label: string | null }>(
      `select c.id, c.body, c.is_internal, c.source, c.created_at, c.author_id, u.full_name as author_name, c.author_label
         from ticket_comments c left join users u on u.id = c.author_id
        where c.ticket_id = $1 ${access.canSeeInternal ? "" : "and not c.is_internal"}
        order by c.created_at`,
      [t.id],
      db
    ),
    access.isStaff
      ? q<{ id: string; action: string; details: Record<string, unknown> | null; created_at: Date; actor_name: string | null }>(
          `select a.id, a.action, a.details, a.created_at, u.full_name as actor_name
             from ticket_activity a left join users u on u.id = a.actor_id
            where a.ticket_id = $1 order by a.created_at desc limit 200`,
          [t.id],
          db
        )
      : Promise.resolve([]),
    q<{ id: string; file_name: string; content_type: string; size_bytes: number; created_at: Date; storage_key: string | null; scan_status: string; uploaded_by_name: string | null }>(
      `select f.id, f.file_name, f.content_type, f.size_bytes, f.created_at, f.storage_key, f.scan_status, u.full_name as uploaded_by_name
         from files f left join users u on u.id = f.uploaded_by
        where f.entity_type = 'ticket' and f.entity_id = $1 and f.tenant_id = $2 order by f.created_at`,
      [t.id, t.tenant_id],
      db
    ),
    q<{ id: string; link_type: string; direction: "out" | "in"; other_number: string; other_subject: string; other_status: string; other_type: string }>(
      `select l.id, l.link_type, 'out' as direction, o.number as other_number, o.subject as other_subject, o.status as other_status, o.ticket_type as other_type
         from ticket_links l join tickets o on o.id = l.to_ticket where l.from_ticket = $1
       union all
       select l.id, l.link_type, 'in', o.number, o.subject, o.status, o.ticket_type
         from ticket_links l join tickets o on o.id = l.from_ticket where l.to_ticket = $1`,
      [t.id],
      db
    ),
    q<{ ci_id: string; role: string; ci_code: string; name: string; status: string; class_name: string }>(
      `select tc.ci_id, tc.role, c.ci_code, c.name, c.status, cl.name as class_name
         from ticket_cis tc join configuration_items c on c.id = tc.ci_id join ci_classes cl on cl.id = c.class_id
        where tc.ticket_id = $1 order by c.ci_code`,
      [t.id],
      db
    ),
    clocksForTicket(db, t.id),
    approvalsForTicket(db, t.id),
    q<{ id: string; title: string; status: string; assignee_name: string | null; group_name: string | null; completed_at: Date | null; assignee_id: string | null }>(
      `select k.id, k.title, k.status, u.full_name as assignee_name, g.name as group_name, k.completed_at, k.assignee_id
         from ticket_tasks k left join users u on u.id = k.assignee_id left join groups g on g.id = k.group_id
        where k.ticket_id = $1 order by k.sort_order`,
      [t.id],
      db
    ),
    q<{ user_id: string; full_name: string }>(
      "select w.user_id, u.full_name from ticket_watchers w join users u on u.id = w.user_id where w.ticket_id = $1",
      [t.id],
      db
    ),
    q<{ id: string; number: string; title: string }>(
      `select a.id, a.number, a.title from kb_article_tickets k join kb_articles a on a.id = k.article_id where k.ticket_id = $1`,
      [t.id],
      db
    ),
  ])
  return { ticket: t, access, config, comments, activity, files, links, cis, clocks, approvals, tasks, watchers, kb }
}

/** People who can be assigned tickets, and the active groups (for pickers). */
export async function assignmentOptions(tenantId: string) {
  const [people, groups] = await Promise.all([
    q<{ id: string; full_name: string; email: string }>(
      `select u.id, u.full_name, u.email from users u left join custom_roles r on r.tenant_id = u.tenant_id and r.key = u.role
        where u.tenant_id = $1 and u.status = 'active'
          and (u.role in ('engineer', 'admin', 'superadmin') or 'ticket.work' = any(coalesce(r.permissions, '{}')))
        order by u.full_name, u.email`,
      [tenantId]
    ),
    q<{ id: string; name: string; kind: string }>("select id, name, kind from groups where tenant_id = $1 and is_active order by name", [tenantId]),
  ])
  return { people, groups }
}

export async function requesterOptions(tenantId: string) {
  return q<{ id: string; full_name: string; email: string }>(
    "select id, full_name, email from users where tenant_id = $1 and status = 'active' order by full_name, email limit 2000",
    [tenantId]
  )
}
