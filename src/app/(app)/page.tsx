import Link from "next/link"
import { requireActor, can } from "@/lib/auth/session"
import { q, q1 } from "@/lib/db"
import { listTickets } from "@/lib/itsm/queries"
import { Card, EmptyState, PageHeader, PriorityBadge, Stat, StatusBadge, When } from "@/components/ui"
import { PRIORITY_LABELS, type Priority } from "@/lib/itsm/vocab"

export const metadata = { title: "Dashboard" }

function Bars({ rows, max }: { rows: { label: string; value: number; href?: string }[]; max: number }) {
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[8rem_1fr_2.5rem] items-center gap-2 text-sm">
          <span className="truncate text-slate-600">{r.href ? <Link href={r.href}>{r.label}</Link> : r.label}</span>
          <span className="h-2.5 rounded bg-slate-100">
            <span className="block h-2.5 rounded bg-brand" style={{ width: `${max ? Math.max(2, (r.value / max) * 100) : 0}%` }} />
          </span>
          <span className="text-right tabular-nums text-slate-700">{r.value}</span>
        </li>
      ))}
    </ul>
  )
}

export default async function Dashboard() {
  const actor = await requireActor()
  const tz = actor.tenant.timezone
  const staff = can(actor, "ticket.view_all")

  if (!staff) {
    const mine = await listTickets(actor, { requester: "me", view: "active", pageSize: 10 })
    return (
      <>
        <PageHeader title={`Hello, ${actor.name.split(" ")[0]}`} subtitle="How can we help today?" />
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Link href="/tickets/new?type=incident" className="card card-body text-inherit no-underline hover:border-brand hover:no-underline">
            <div className="font-semibold">Report a problem</div>
            <div className="text-sm text-slate-500">Something is broken or not working</div>
          </Link>
          <Link href="/catalog" className="card card-body text-inherit no-underline hover:border-brand hover:no-underline">
            <div className="font-semibold">Request something</div>
            <div className="text-sm text-slate-500">Access, software, hardware and more</div>
          </Link>
          <Link href="/kb" className="card card-body text-inherit no-underline hover:border-brand hover:no-underline">
            <div className="font-semibold">Find an answer</div>
            <div className="text-sm text-slate-500">Search the knowledge base</div>
          </Link>
        </div>
        <Card title="My open tickets" actions={<Link href="/tickets" className="text-xs">All my tickets</Link>}>
          {mine.rows.length === 0 ? (
            <p className="text-sm text-slate-500">You have no open tickets.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {mine.rows.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    <Link href={`/tickets/${t.number}`} className="font-mono text-xs">{t.number}</Link> {t.subject}
                  </span>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>
    )
  }

  const t = actor.tenantId
  const [counts, byPriority, created, myQueue, breaches, devices, patches, approvals] = await Promise.all([
    q1<{ open: number; unassigned: number; mine: number; breached: number; at_risk: number; resolved_today: number; created_today: number }>(
      `select
         count(*) filter (where status not in ('resolved','closed','cancelled','rejected')) as open,
         count(*) filter (where status not in ('resolved','closed','cancelled','rejected','draft') and assignee_id is null) as unassigned,
         count(*) filter (where status not in ('resolved','closed','cancelled','rejected') and assignee_id = $2) as mine,
         count(*) filter (where status not in ('resolved','closed','cancelled','rejected') and (sla_resolution_breached or sla_response_breached)) as breached,
         count(*) filter (where status not in ('resolved','closed','cancelled','rejected','on_hold','pending_approval') and not sla_resolution_breached
                          and sla_resolution_due between now() and now() + interval '2 hours') as at_risk,
         count(*) filter (where resolved_at >= date_trunc('day', now())) as resolved_today,
         count(*) filter (where created_at >= date_trunc('day', now())) as created_today
       from tickets where tenant_id = $1`,
      [t, actor.id]
    ),
    q<{ priority: Priority; n: number }>(
      "select priority, count(*) as n from tickets where tenant_id = $1 and status not in ('resolved','closed','cancelled','rejected') group by priority",
      [t]
    ),
    q<{ day: string; n: number }>(
      `select to_char(d, 'DD Mon') as day, coalesce(c.n, 0) as n
         from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
         left join (select date_trunc('day', created_at) as day, count(*) as n from tickets where tenant_id = $1 and created_at > now() - interval '14 days' group by 1) c on c.day = d
        order by d`,
      [t]
    ),
    listTickets(actor, { assignee: "me", view: "active", sort: "due", pageSize: 8 }),
    listTickets(actor, { sla: "breached", view: "active", sort: "due", pageSize: 5 }),
    can(actor, "endpoint.view")
      ? q1<{ total: number; online: number; reboot: number }>(
          `select count(*) as total, count(*) filter (where last_seen_at > now() - interval '10 minutes') as online,
                  count(*) filter (where reboot_pending) as reboot from devices where tenant_id = $1 and status = 'active'`,
          [t]
        )
      : Promise.resolve(null),
    can(actor, "endpoint.view")
      ? q1<{ critical_missing: number; devices_missing: number }>(
          `select count(*) filter (where p.severity = 'critical') as critical_missing, count(distinct dp.device_id) as devices_missing
             from device_patches dp join patches p on p.id = dp.patch_id join devices d on d.id = dp.device_id
            where p.tenant_id = $1 and dp.state = 'missing' and d.status = 'active' and p.approval <> 'declined'`,
          [t]
        )
      : Promise.resolve(null),
    q1<{ n: number }>(
      "select count(*) as n from approvals where tenant_id = $1 and status = 'pending' and (approver_id = $2 or group_id = any($3::uuid[]))",
      [t, actor.id, actor.groupIds]
    ),
  ])
  const maxPri = Math.max(0, ...byPriority.map((p) => p.n))
  const maxDay = Math.max(1, ...created.map((d) => d.n))

  return (
    <>
      <PageHeader title="Service desk overview" subtitle={actor.tenant.brandName} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Open" value={counts?.open ?? 0} href="/tickets" />
        <Stat label="Unassigned" value={counts?.unassigned ?? 0} href="/tickets?assignee=unassigned" tone={counts?.unassigned ? "amber" : undefined} />
        <Stat label="Mine" value={counts?.mine ?? 0} href="/tickets?assignee=me" />
        <Stat label="SLA breached" value={counts?.breached ?? 0} href="/tickets?sla=breached" tone={counts?.breached ? "red" : undefined} />
        <Stat label="Due in 2 h" value={counts?.at_risk ?? 0} href="/tickets?sla=at_risk&sort=due" tone={counts?.at_risk ? "amber" : undefined} />
        <Stat label="Raised today" value={counts?.created_today ?? 0} />
        <Stat label="Resolved today" value={counts?.resolved_today ?? 0} tone="green" />
      </div>
      {(devices || approvals?.n) && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {devices && <Stat label="Devices online" value={`${devices.online} / ${devices.total}`} href="/endpoints" />}
          {patches && <Stat label="Critical patches missing" value={patches.critical_missing} href="/patches?severity=critical" tone={patches.critical_missing ? "red" : "green"} sub={`${patches.devices_missing} devices need patches`} />}
          {devices && <Stat label="Reboot pending" value={devices.reboot} href="/endpoints?reboot=1" tone={devices.reboot ? "amber" : undefined} />}
          <Stat label="My approvals" value={approvals?.n ?? 0} href="/approvals" tone={approvals?.n ? "amber" : undefined} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="My queue (by due time)" className="lg:col-span-2" actions={<Link href="/tickets?assignee=me" className="text-xs">Open my work</Link>}>
          {myQueue.rows.length === 0 ? (
            <EmptyState title="Nothing assigned to you">
              <Link href="/tickets?assignee=unassigned">Pick up an unassigned ticket</Link>
            </EmptyState>
          ) : (
            <table className="table">
              <tbody>
                {myQueue.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">
                      <Link href={`/tickets/${r.number}`} className="font-mono text-xs">{r.number}</Link>
                    </td>
                    <td className="max-w-xs truncate">{r.subject}</td>
                    <td><PriorityBadge priority={r.priority} /></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="text-xs text-slate-500">{r.sla_resolution_due ? <>due <When value={r.sla_resolution_due} timeZone={tz} /></> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Open by priority">
          <Bars max={maxPri} rows={(["critical", "high", "medium", "low"] as Priority[]).map((p) => ({ label: PRIORITY_LABELS[p], value: byPriority.find((b) => b.priority === p)?.n ?? 0, href: `/tickets?priority=${p}` }))} />
        </Card>
        <Card title="Raised per day (14 days)" className="lg:col-span-2">
          <div className="flex h-32 items-end gap-1">
            {created.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.n}`}>
                <div className="w-full rounded-t bg-brand/80" style={{ height: `${(d.n / maxDay) * 100}%`, minHeight: d.n ? 3 : 0 }} />
                <span className="text-[10px] text-slate-400">{d.day.slice(0, 2)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="SLA breaches" actions={<Link href="/tickets?sla=breached" className="text-xs">All</Link>}>
          {breaches.rows.length === 0 ? (
            <p className="text-sm text-emerald-700">No open tickets have breached their SLA.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {breaches.rows.map((r) => (
                <li key={r.id} className="truncate">
                  <Link href={`/tickets/${r.number}`} className="font-mono text-xs">{r.number}</Link> {r.subject}
                  <span className="text-xs text-slate-400"> · {r.assignee_name ?? "unassigned"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
