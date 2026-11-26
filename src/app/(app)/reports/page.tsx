import Link from "next/link"
import type { ReactNode } from "react"
import { requirePermission, can } from "@/lib/auth/session"
import { ticketReport } from "@/lib/reports/queries"
import { addDays, formatPercent, localDay, resolveRange, type ReportRange } from "@/lib/reports/helpers"
import { formatMinutes } from "@/lib/itsm/clock"
import { formatDate } from "@/lib/format"
import { PRIORITY_LABELS, TICKET_TYPES, TICKET_TYPE_LABELS, humanize, type Priority, type TicketType } from "@/lib/itsm/vocab"
import { Card, EmptyState, PageHeader, Stat, qs } from "@/components/ui"

export const metadata = { title: "Reports" }

type SP = Record<string, string | undefined>

function Bars({ rows, empty = "No data in this period" }: { rows: { label: string; value: number; sub?: string }[]; empty?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value))
  if (!rows.length || max === 0) return <p className="text-sm text-slate-500">{empty}</p>
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[9rem_1fr_3.5rem] items-center gap-2 text-sm" title={`${r.label}: ${r.value}${r.sub ? ` (${r.sub})` : ""}`}>
          <span className="truncate text-slate-600">{r.label}</span>
          <span className="h-2.5 rounded bg-slate-100">
            <span className="block h-2.5 rounded bg-brand" style={{ width: `${Math.max(r.value ? 2 : 0, (r.value / max) * 100)}%` }} />
          </span>
          <span className="text-right text-slate-700 tabular-nums">{r.value}</span>
        </li>
      ))}
    </ul>
  )
}

function label(dim: "type" | "priority" | "source" | "category", key: string) {
  if (dim === "type") return TICKET_TYPE_LABELS[key as TicketType] ?? humanize(key)
  if (dim === "priority") return PRIORITY_LABELS[key as Priority] ?? humanize(key)
  if (dim === "source") return humanize(key)
  return key
}

function Pct({ v }: { v: number | null }) {
  if (v === null) return <span className="text-slate-400">—</span>
  const tone = v >= 95 ? "text-emerald-700" : v >= 80 ? "text-amber-700" : "text-red-700"
  return <span className={`font-medium tabular-nums ${tone}`}>{formatPercent(v)}</span>
}

function Th({ children, right }: { children?: ReactNode; right?: boolean }) {
  return <th className={right ? "text-right" : undefined}>{children}</th>
}

function presets(today: string): { label: string; from: string; to: string }[] {
  const [y, m] = today.split("-")
  return [
    { label: "7 days", from: addDays(today, -6), to: today },
    { label: "30 days", from: addDays(today, -29), to: today },
    { label: "90 days", from: addDays(today, -89), to: today },
    { label: "This month", from: `${y}-${m}-01`, to: today },
    { label: "12 months", from: addDays(today, -364), to: today },
  ]
}

function RaisedResolvedChart({ series, range }: { series: { key: string; raised: number; resolved: number }[]; range: ReportRange }) {
  const max = Math.max(1, ...series.map((d) => Math.max(d.raised, d.resolved)))
  const every = Math.ceil(series.length / 15)
  const fmt = (k: string) => (range.granularity === "week" ? `week of ${formatDate(k)}` : formatDate(k))
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-brand" /> Raised
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-400" /> Resolved
        </span>
        <span className="ml-auto text-slate-400">per {range.granularity} · max {max}</span>
      </div>
      <div className="flex h-40 items-end gap-0.5 border-b border-slate-200">
        {series.map((d) => (
          <div key={d.key} className="flex h-full flex-1 items-end justify-center gap-px hover:bg-slate-50" title={`${fmt(d.key)}: ${d.raised} raised, ${d.resolved} resolved`}>
            <div className="w-1/2 max-w-3 rounded-t bg-brand" style={{ height: `${(d.raised / max) * 100}%`, minHeight: d.raised ? 2 : 0 }} />
            <div className="w-1/2 max-w-3 rounded-t bg-slate-400" style={{ height: `${(d.resolved / max) * 100}%`, minHeight: d.resolved ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-0.5">
        {series.map((d, i) => (
          <span key={d.key} className="flex-1 truncate text-center text-[10px] text-slate-400">
            {i % every === 0 ? d.key.slice(8, 10) + "/" + d.key.slice(5, 7) : ""}
          </span>
        ))}
      </div>
    </div>
  )
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("report.view")
  const sp = await searchParams
  const tz = actor.tenant.timezone
  const range = resolveRange({ from: sp.from, to: sp.to }, tz)
  const type = sp.type && (TICKET_TYPES as readonly string[]).includes(sp.type) ? sp.type : ""
  const r = await ticketReport(actor, { range, type: type || null })
  const today = localDay(new Date(), tz)
  const base = { from: range.from, to: range.to, type }
  const sla = r.sla
  const changesShown = !type || type === "change"

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`${formatDate(range.from)} – ${formatDate(range.to)} (${range.days} days, ${tz})${type ? ` · ${TICKET_TYPE_LABELS[type as TicketType]}s only` : ""}`}
        actions={
          <>
            {can(actor, "audit.view") && (
              <Link className="btn" href="/reports/audit">
                Audit log
              </Link>
            )}
            <a className="btn" href={`/api/export/tickets${qs({ view: "all", type })}`}>
              Export tickets (CSV)
            </a>
          </>
        }
      />

      <form method="get" className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label" htmlFor="from">From</label>
          <input id="from" name="from" type="date" className="input" defaultValue={range.from} max={today} />
        </div>
        <div>
          <label className="label" htmlFor="to">To</label>
          <input id="to" name="to" type="date" className="input" defaultValue={range.to} />
        </div>
        <div>
          <label className="label" htmlFor="type">Record type</label>
          <select id="type" name="type" className="input" defaultValue={type}>
            <option value="">All types</option>
            {TICKET_TYPES.map((t) => (
              <option key={t} value={t}>{TICKET_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary">Apply</button>
        <div className="flex flex-wrap gap-1 text-xs">
          {presets(today).map((p) => (
            <Link key={p.label} className="btn btn-ghost btn-sm" href={`/reports${qs({ ...base, from: p.from, to: p.to })}`}>
              {p.label}
            </Link>
          ))}
        </div>
      </form>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Raised" value={r.totals.raised} />
        <Stat label="Resolved" value={r.totals.resolved} tone="green" sub={r.resolvedRate !== null ? `${formatPercent(r.resolvedRate)} of raised` : undefined} />
        <Stat label="Open now" value={r.totals.open} href={`/tickets${qs({ type })}`} />
        <Stat
          label="Response SLA met"
          value={formatPercent(sla.byKind.response.pct)}
          tone={sla.byKind.response.pct === null ? undefined : sla.byKind.response.pct >= 95 ? "green" : sla.byKind.response.pct >= 80 ? "amber" : "red"}
          sub={`${sla.byKind.response.total} clocks`}
        />
        <Stat
          label="Resolution SLA met"
          value={formatPercent(sla.byKind.resolution.pct)}
          tone={sla.byKind.resolution.pct === null ? undefined : sla.byKind.resolution.pct >= 95 ? "green" : sla.byKind.resolution.pct >= 80 ? "amber" : "red"}
          sub={`${sla.byKind.resolution.total} clocks`}
        />
        <Stat label="Mean time to resolve" value={r.times.overall.mttr === null ? "—" : formatMinutes(r.times.overall.mttr)} sub={`${r.times.overall.resolved} resolved`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={`Raised and resolved per ${range.granularity}`} className="lg:col-span-3">
          <RaisedResolvedChart series={r.series} range={range} />
        </Card>

        <Card title="By type">
          <Bars rows={r.volume.byType.map((v) => ({ label: label("type", v.key), value: v.n }))} />
        </Card>
        <Card title="By priority">
          <Bars rows={r.volume.byPriority.map((v) => ({ label: label("priority", v.key), value: v.n }))} />
        </Card>
        <Card title="By source">
          <Bars rows={r.volume.bySource.map((v) => ({ label: label("source", v.key), value: v.n }))} />
        </Card>
        <Card title="By category (top 15)">
          <Bars rows={r.volume.byCategory.map((v) => ({ label: v.key, value: v.n }))} />
        </Card>
        <Card title="Backlog ageing (open now)">
          <Bars rows={r.ageing.map((a) => ({ label: a.label, value: a.n }))} empty="No open tickets" />
        </Card>
        <Card title="Change success (closed in period)">
          {!changesShown ? (
            <p className="text-sm text-slate-500">Choose all types or changes to see change outcomes.</p>
          ) : r.changes.total === 0 ? (
            <p className="text-sm text-slate-500">No changes were closed with an outcome in this period.</p>
          ) : (
            <>
              <div className="mb-3 text-sm">
                Success rate <Pct v={r.changes.successRate} /> <span className="text-slate-400">of {r.changes.total}</span>
              </div>
              <Bars rows={r.changes.rows.map((c) => ({ label: humanize(c.outcome), value: c.n, sub: formatPercent(c.pct) }))} />
            </>
          )}
        </Card>

        <Card title="SLA compliance (clocks stopped in period)" className="lg:col-span-2" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <Th>Priority</Th>
                  <Th right>Response met</Th>
                  <Th right>Breached</Th>
                  <Th right>Compliance</Th>
                  <Th right>Resolution met</Th>
                  <Th right>Breached</Th>
                  <Th right>Compliance</Th>
                </tr>
              </thead>
              <tbody>
                {(["critical", "high", "medium", "low"] as Priority[]).map((p) => {
                  const resp = sla.byPriority[p].response
                  const res = sla.byPriority[p].resolution
                  return (
                    <tr key={p}>
                      <td>{PRIORITY_LABELS[p]}</td>
                      <td className="text-right tabular-nums">{resp.met}</td>
                      <td className="text-right tabular-nums">{resp.breached}</td>
                      <td className="text-right"><Pct v={resp.pct} /></td>
                      <td className="text-right tabular-nums">{res.met}</td>
                      <td className="text-right tabular-nums">{res.breached}</td>
                      <td className="text-right"><Pct v={res.pct} /></td>
                    </tr>
                  )
                })}
                <tr className="font-medium">
                  <td>All</td>
                  <td className="text-right tabular-nums">{sla.byKind.response.met}</td>
                  <td className="text-right tabular-nums">{sla.byKind.response.breached}</td>
                  <td className="text-right"><Pct v={sla.byKind.response.pct} /></td>
                  <td className="text-right tabular-nums">{sla.byKind.resolution.met}</td>
                  <td className="text-right tabular-nums">{sla.byKind.resolution.breached}</td>
                  <td className="text-right"><Pct v={sla.byKind.resolution.pct} /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Resolution and first response times" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <Th>Priority</Th>
                  <Th right>MTTR</Th>
                  <Th right>First response</Th>
                </tr>
              </thead>
              <tbody>
                {[...r.times.byPriority, { priority: "all", ...r.times.overall }].map((t) => (
                  <tr key={t.priority} className={t.priority === "all" ? "font-medium" : undefined}>
                    <td>{t.priority === "all" ? "All" : PRIORITY_LABELS[t.priority as Priority]}</td>
                    <td className="text-right tabular-nums" title={`${t.resolved} resolved`}>
                      {t.mttr === null ? <span className="text-slate-400">—</span> : formatMinutes(t.mttr)}
                      <div className="text-[11px] font-normal text-slate-400">{t.resolved} resolved</div>
                    </td>
                    <td className="text-right tabular-nums" title={`${t.responded} responded`}>
                      {t.mtfr === null ? <span className="text-slate-400">—</span> : formatMinutes(t.mtfr)}
                      <div className="text-[11px] font-normal text-slate-400">{t.responded} responded</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-[11px] text-slate-400">Wall-clock time from creation (not business hours).</p>
        </Card>

        <Card title="Agent workload" className="lg:col-span-2" bodyClassName="p-0">
          {r.workload.agents.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No assigned work">Nothing was open or resolved by an assignee in this period.</EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <Th>Assignee</Th>
                    <Th right>Open now</Th>
                    <Th right>Resolved in period</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.workload.agents.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <Link href={`/tickets${qs({ assignee: a.id, type })}`}>{a.name}</Link>
                      </td>
                      <td className="text-right tabular-nums">{a.open}</td>
                      <td className="text-right tabular-nums">{a.resolved}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="text-slate-500">
                      <Link href={`/tickets${qs({ assignee: "unassigned", type })}`}>Unassigned</Link>
                    </td>
                    <td className="text-right tabular-nums">{r.workload.unassigned}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Group workload" bodyClassName="p-0">
          {r.workload.groups.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No group work in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <Th>Group</Th>
                    <Th right>Open</Th>
                    <Th right>Resolved</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.workload.groups.map((g) => (
                    <tr key={g.id ?? "none"}>
                      <td>{g.id ? <Link href={`/tickets${qs({ group: g.id, type })}`}>{g.name}</Link> : <span className="text-slate-500">{g.name}</span>}</td>
                      <td className="text-right tabular-nums">{g.open}</td>
                      <td className="text-right tabular-nums">{g.resolved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
