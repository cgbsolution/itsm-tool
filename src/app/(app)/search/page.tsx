import Link from "next/link"
import { requireActor, can } from "@/lib/auth/session"
import { q } from "@/lib/db"
import { listTickets } from "@/lib/itsm/queries"
import { Card, EmptyState, PageHeader, StatusBadge, TypeBadge } from "@/components/ui"

export const metadata = { title: "Search" }

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const actor = await requireActor()
  const text = ((await searchParams).q ?? "").trim().slice(0, 200)
  if (!text) return <EmptyState title="Type something to search for" />
  const like = `%${text.replace(/[\\%_]/g, (c) => "\\" + c)}%`
  const staff = can(actor, "ticket.view_all")
  const [tickets, articles, cis, devices, people] = await Promise.all([
    listTickets(actor, { q: text, view: "all", pageSize: 10 }),
    q<{ id: string; number: string; title: string; summary: string | null }>(
      `select id, number, title, summary from kb_articles
        where tenant_id = $1 and (search @@ websearch_to_tsquery('simple', $2) or title ilike $3)
          and (${can(actor, "kb.write") ? "true" : `status = 'published' and (visibility = 'public' ${staff ? "or true" : ""})`})
        order by ts_rank(search, websearch_to_tsquery('simple', $2)) desc limit 8`,
      [actor.tenantId, text, like]
    ),
    can(actor, "cmdb.view")
      ? q<{ id: string; ci_code: string; name: string; status: string }>(
          `select id, ci_code, name, status from configuration_items
            where tenant_id = $1 and (search @@ plainto_tsquery('simple', $2) or ci_code ilike $3 or serial_no ilike $3)
            order by ci_code limit 8`,
          [actor.tenantId, text, like]
        )
      : Promise.resolve([]),
    can(actor, "endpoint.view")
      ? q<{ id: string; hostname: string; os_name: string | null }>(
          `select id, hostname, os_name from devices
            where tenant_id = $1 and status = 'active' and (hostname ilike $2 or serial_no ilike $2 or $3 = any(ip_addresses))
            order by hostname limit 8`,
          [actor.tenantId, like, text]
        )
      : Promise.resolve([]),
    staff
      ? q<{ id: string; full_name: string; email: string; department: string | null }>(
          "select id, full_name, email, department from users where tenant_id = $1 and (full_name ilike $2 or email ilike $2) order by full_name limit 8",
          [actor.tenantId, like]
        )
      : Promise.resolve([]),
  ])
  const nothing = !tickets.rows.length && !articles.length && !cis.length && !devices.length && !people.length
  return (
    <>
      <PageHeader title={`Results for “${text}”`} />
      {nothing && <EmptyState title="Nothing found">Try fewer or different words, or a ticket number.</EmptyState>}
      <div className="grid gap-4 lg:grid-cols-2">
        {tickets.rows.length > 0 && (
          <Card title={`Tickets (${tickets.total})`} actions={<Link href={`/tickets?q=${encodeURIComponent(text)}&view=all`} className="text-xs">All</Link>}>
            <ul className="space-y-1.5 text-sm">
              {tickets.rows.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <TypeBadge type={t.ticket_type} />
                  <Link href={`/tickets/${t.number}`} className="font-mono text-xs">{t.number}</Link>
                  <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          </Card>
        )}
        {articles.length > 0 && (
          <Card title="Knowledge articles">
            <ul className="space-y-1.5 text-sm">
              {articles.map((a) => (
                <li key={a.id}>
                  <Link href={`/kb/${a.id}`}>{a.title}</Link> <span className="text-xs text-slate-400">{a.number}</span>
                  {a.summary && <div className="truncate text-xs text-slate-500">{a.summary}</div>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {cis.length > 0 && (
          <Card title="Configuration items">
            <ul className="space-y-1.5 text-sm">
              {cis.map((c) => (
                <li key={c.id}>
                  <Link href={`/cmdb/${c.id}`} className="font-mono text-xs">{c.ci_code}</Link> {c.name} <span className="text-xs text-slate-400">{c.status}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {devices.length > 0 && (
          <Card title="Devices">
            <ul className="space-y-1.5 text-sm">
              {devices.map((d) => (
                <li key={d.id}>
                  <Link href={`/endpoints/${d.id}`}>{d.hostname}</Link> <span className="text-xs text-slate-400">{d.os_name}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {people.length > 0 && (
          <Card title="People">
            <ul className="space-y-1.5 text-sm">
              {people.map((p) => (
                <li key={p.id}>
                  {can(actor, "admin.users") ? <Link href={`/admin/users/${p.id}`}>{p.full_name || p.email}</Link> : p.full_name || p.email}
                  <span className="text-xs text-slate-400"> · {p.email}{p.department ? ` · ${p.department}` : ""}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  )
}
