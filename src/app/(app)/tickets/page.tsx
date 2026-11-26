import Link from "next/link"
import { requireActor, can } from "@/lib/auth/session"
import { listTickets } from "@/lib/itsm/queries"
import { q } from "@/lib/db"
import { TICKET_TYPES, TICKET_TYPE_LABELS, PRIORITIES, PRIORITY_LABELS, isTicketType } from "@/lib/itsm/vocab"
import { STATUSES, STATUS_LABELS, STATE_CATEGORY, TYPE_STATUSES } from "@/lib/itsm/workflow"
import { Badge, EmptyState, PageHeader, Pagination, PriorityBadge, SlaBadge, StatusBadge, TypeBadge, When, qs } from "@/components/ui"

export const metadata = { title: "Tickets" }

type SP = Record<string, string | undefined>

export default async function TicketsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requireActor()
  const sp = await searchParams
  const staff = can(actor, "ticket.view_all")
  const filters = {
    type: sp.type,
    view: sp.view ?? "active",
    assignee: sp.assignee,
    group: sp.group,
    priority: sp.priority,
    requester: sp.requester,
    sla: sp.sla,
    q: sp.q,
    sort: sp.sort,
    page: Number(sp.page) || 1,
  }
  const [{ rows, total, page, pageSize }, groups] = await Promise.all([
    listTickets(actor, filters),
    staff ? q<{ id: string; name: string }>("select id, name from groups where tenant_id = $1 and is_active order by name", [actor.tenantId]) : Promise.resolve([]),
  ])
  const base: SP = { ...sp, page: undefined }
  const typeLabel = filters.type && isTicketType(filters.type) ? TICKET_TYPE_LABELS[filters.type] + "s" : staff ? "All tickets" : "My tickets"
  const statusOptions = filters.type && isTicketType(filters.type) ? TYPE_STATUSES[filters.type] : STATUSES
  const newTypes = TICKET_TYPES.filter((t) =>
    t === "problem" ? can(actor, "problem.manage") : t === "change" ? can(actor, "change.manage") : staff || t === "incident" || t === "service_request"
  )
  const tz = actor.tenant.timezone

  return (
    <>
      <PageHeader
        title={filters.assignee === "me" ? "My work" : typeLabel}
        subtitle={`${total} ${filters.view === "active" ? "open" : ""} record${total === 1 ? "" : "s"}`}
        actions={
          <>
            {can(actor, "report.view") && (
              <a className="btn" href={`/api/export/tickets${qs(base)}`}>
                Export CSV
              </a>
            )}
            {newTypes.map((t) => (
              <Link key={t} className={t === (filters.type ?? "incident") ? "btn btn-primary" : "btn"} href={`/tickets/new?type=${t}`}>
                New {TICKET_TYPE_LABELS[t].toLowerCase()}
              </Link>
            ))}
          </>
        }
      />

      <form className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-7" method="get">
        <input name="q" defaultValue={sp.q} placeholder="Number or text…" className="input lg:col-span-2" />
        <select name="type" defaultValue={sp.type ?? ""} className="input">
          <option value="">All types</option>
          {TICKET_TYPES.map((t) => (
            <option key={t} value={t}>{TICKET_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select name="view" defaultValue={filters.view} className="input">
          <option value="active">Open</option>
          <option value="resolved">Resolved</option>
          <option value="done">Closed / cancelled</option>
          <option value="all">Any status</option>
          <optgroup label="Status">
            {statusOptions.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </optgroup>
        </select>
        <select name="priority" defaultValue={sp.priority ?? ""} className="input">
          <option value="">Any priority</option>
          {[...PRIORITIES].reverse().map((p) => (
            <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
          ))}
        </select>
        {staff ? (
          <select name="assignee" defaultValue={sp.assignee ?? ""} className="input">
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        ) : (
          <input type="hidden" name="assignee" value={sp.assignee ?? ""} />
        )}
        <div className="flex gap-2">
          {staff && groups.length > 0 && (
            <select name="group" defaultValue={sp.group ?? ""} className="input">
              <option value="">Any group</option>
              <option value="mine">My groups</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          <button className="btn btn-primary">Filter</button>
        </div>
        <input type="hidden" name="sort" value={sp.sort ?? ""} />
        {sp.sla && <input type="hidden" name="sla" value={sp.sla} />}
      </form>

      {rows.length === 0 ? (
        <EmptyState title="Nothing here">
          {filters.view === "active" ? "No open records match these filters." : "No records match these filters."}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>
                  <Link href={`/tickets${qs(base, { sort: undefined })}`}>Number</Link>
                </th>
                <th>Subject</th>
                <th>
                  <Link href={`/tickets${qs(base, { sort: "priority" })}`}>Priority</Link>
                </th>
                <th>Status</th>
                {staff && <th>Requester</th>}
                <th>Assigned</th>
                <th>
                  <Link href={`/tickets${qs(base, { sort: "due" })}`}>SLA</Link>
                </th>
                <th>
                  <Link href={`/tickets${qs(base, { sort: "updated" })}`}>Updated</Link>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap">
                    <Link href={`/tickets/${t.number}`} className="font-mono text-xs font-medium">
                      {t.number}
                    </Link>
                    {!filters.type && (
                      <div className="mt-0.5">
                        <TypeBadge type={t.ticket_type} />
                      </div>
                    )}
                  </td>
                  <td className="max-w-md">
                    <Link href={`/tickets/${t.number}`} className="text-slate-800">
                      {t.subject}
                    </Link>
                    {t.category && (
                      <div className="text-xs text-slate-500">
                        {t.category}
                        {t.sub_category ? ` › ${t.sub_category}` : ""}
                      </div>
                    )}
                  </td>
                  <td>
                    <PriorityBadge priority={t.priority} />
                  </td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  {staff && <td className="text-slate-600">{t.requester_name ?? "—"}</td>}
                  <td className="text-slate-600">
                    {t.assignee_name ?? <Badge tone="amber">Unassigned</Badge>}
                    {t.group_name && <div className="text-xs text-slate-400">{t.group_name}</div>}
                  </td>
                  <td>
                    <SlaBadge
                      due={t.sla_resolution_due}
                      breached={t.sla_resolution_breached || t.sla_response_breached}
                      active={STATE_CATEGORY[t.status] === "open"}
                      timeZone={tz}
                    />
                  </td>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    <When value={t.updated_at} timeZone={tz} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/tickets${qs(base, { page: p })}`} />
    </>
  )
}
