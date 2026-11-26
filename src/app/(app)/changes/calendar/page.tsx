import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { changeCalendar, type CalendarEvent } from "@/lib/reports/calendar"
import { localDay, monthKey, parseMonth, shiftMonth } from "@/lib/reports/helpers"
import { STATUS_LABELS, type Status } from "@/lib/itsm/workflow"
import { humanize } from "@/lib/itsm/vocab"
import { Badge, EmptyState, PageHeader, StatusBadge, cx, qs } from "@/components/ui"

export const metadata = { title: "Change calendar" }

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** Pill colours per change status (solid enough to read at a glance on the grid). */
function changeClass(status: string | undefined): string {
  switch (status) {
    case "draft":
    case "assessment":
      return "bg-slate-100 text-slate-700 ring-slate-200"
    case "pending_approval":
      return "bg-amber-50 text-amber-800 ring-amber-200"
    case "approved":
    case "scheduled":
      return "bg-blue-50 text-blue-800 ring-blue-200"
    case "implementing":
      return "bg-violet-50 text-violet-800 ring-violet-200"
    case "review":
    case "closed":
      return "bg-emerald-50 text-emerald-800 ring-emerald-200"
    case "rejected":
    case "cancelled":
      return "bg-slate-50 text-slate-400 line-through ring-slate-200"
    default:
      return "bg-slate-100 text-slate-700 ring-slate-200"
  }
}

function time(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)
}

function when(e: CalendarEvent, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  if (!e.end) return f.format(e.start)
  const sameDay = localDay(e.start, tz) === localDay(new Date(e.end.getTime() - 1), tz)
  return `${f.format(e.start)} – ${sameDay ? time(e.end, tz) : f.format(e.end)}`
}

function EventPill({ e, day, tz }: { e: CalendarEvent; day: string; tz: string }) {
  const startsToday = localDay(e.start, tz) === day
  const prefix = startsToday ? time(e.start, tz) : "…"
  if (e.kind === "change") {
    return (
      <Link
        href={`/tickets/${e.number}`}
        title={`${e.number} ${e.title}\n${STATUS_LABELS[e.status as Status] ?? e.status} · ${when(e, tz)}${e.risk ? ` · risk ${e.risk}` : ""}`}
        className={cx("block truncate rounded px-1.5 py-0.5 text-[11px] leading-4 no-underline ring-1 hover:no-underline hover:brightness-95", changeClass(e.status))}
      >
        <span className="tabular-nums opacity-70">{prefix}</span> <span className="font-mono font-medium">{e.number}</span> {e.title}
      </Link>
    )
  }
  const freeze = e.kind === "blackout"
  return (
    <div
      title={`${freeze ? "Change freeze" : "Maintenance window"}: ${e.title}\n${when(e, tz)}${e.description ? `\n${e.description}` : ""}`}
      className={cx(
        "truncate rounded px-1.5 py-0.5 text-[11px] leading-4 ring-1",
        freeze ? "bg-red-600 font-medium text-white ring-red-700" : "bg-teal-50 text-teal-800 ring-teal-200"
      )}
    >
      {freeze ? "Freeze" : "Window"}: {e.title}
    </div>
  )
}

export default async function ChangeCalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requirePermission("change.manage")
  const sp = await searchParams
  const tz = actor.tenant.timezone
  const month = parseMonth(sp.month, tz)
  const all = sp.all === "1"
  const cal = await changeCalendar(actor, month, { includeClosed: all })
  const today = localDay(new Date(), tz)
  const thisMonth = monthKey(parseMonth(undefined, tz))
  const key = monthKey(month)
  const title = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.year, month.month - 1, 1)))
  const freezeDays = new Set(cal.freezeDays)
  const nav = (m: string) => `/changes/calendar${qs({ month: m, all: all ? "1" : undefined })}`

  return (
    <>
      <PageHeader
        title="Change calendar"
        subtitle={`Planned changes, maintenance windows and change freezes · times in ${tz}`}
        actions={
          <>
            <Link className="btn" href="/tickets?type=change">
              All changes
            </Link>
            <Link className="btn btn-primary" href="/tickets/new?type=change">
              New change
            </Link>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link className="btn btn-sm" href={nav(monthKey(shiftMonth(month, -1)))} aria-label="Previous month">
          ← Previous
        </Link>
        <h2 className="min-w-40 text-center">{title}</h2>
        <Link className="btn btn-sm" href={nav(monthKey(shiftMonth(month, 1)))} aria-label="Next month">
          Next →
        </Link>
        {key !== thisMonth && (
          <Link className="btn btn-ghost btn-sm" href={nav(thisMonth)}>
            Today
          </Link>
        )}
        <form method="get" className="flex items-center gap-2">
          <input type="month" name="month" defaultValue={key} className="input w-auto py-1" aria-label="Month" />
          {all && <input type="hidden" name="all" value="1" />}
          <button className="btn btn-sm">Go</button>
        </form>
        <Link className="ml-auto text-xs" href={`/changes/calendar${qs({ month: key, all: all ? undefined : "1" })}`}>
          {all ? "Hide cancelled and rejected" : "Show cancelled and rejected"}
        </Link>
      </div>

      <div className="mb-2 flex flex-wrap gap-3 text-xs text-slate-600">
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-red-600" /> Change freeze</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-teal-50 ring-1 ring-teal-200" /> Maintenance window</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-amber-50 ring-1 ring-amber-200" /> Awaiting approval</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-blue-50 ring-1 ring-blue-200" /> Approved / scheduled</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-violet-50 ring-1 ring-violet-200" /> Implementing</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-emerald-50 ring-1 ring-emerald-200" /> Review / closed</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-slate-100 ring-1 ring-slate-200" /> Draft / assessment</span>
      </div>

      <div className="card overflow-x-auto">
        <div className="grid min-w-[720px] grid-cols-7">
          {WEEKDAYS.map((d) => (
            <div key={d} className="border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              {d}
            </div>
          ))}
          {cal.weeks.flat().map((day) => {
            const inMonth = day.slice(0, 7) === key
            const events = cal.byDay[day] ?? []
            const freeze = freezeDays.has(day)
            return (
              <div
                key={day}
                className={cx(
                  "min-h-28 border-r border-b border-slate-100 p-1.5 [&:nth-child(7n)]:border-r-0",
                  !inMonth && "bg-slate-50/70",
                  freeze && "bg-red-50"
                )}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    className={cx(
                      "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs",
                      day === today ? "bg-brand font-semibold text-white" : inMonth ? "text-slate-700" : "text-slate-400"
                    )}
                  >
                    {Number(day.slice(8, 10))}
                  </span>
                  {freeze && <span className="text-[10px] font-semibold tracking-wide text-red-700 uppercase">Freeze</span>}
                </div>
                <div className="space-y-0.5">
                  {events.slice(0, 5).map((e) => (
                    <EventPill key={e.key} e={e} day={day} tz={tz} />
                  ))}
                  {events.length > 5 && <div className="px-1 text-[11px] text-slate-500">+{events.length - 5} more</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <h2 className="mt-8 mb-3">Agenda for {title}</h2>
      {cal.agenda.length === 0 ? (
        <EmptyState title="Nothing planned">No changes, maintenance windows or freezes this month.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Details</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {cal.agenda.map((e) => (
                <tr key={e.key} className={e.kind === "blackout" ? "bg-red-50" : undefined}>
                  <td className="text-xs whitespace-nowrap text-slate-600">{when(e, tz)}</td>
                  <td>
                    {e.kind === "change" ? (
                      <Badge tone="slate">Change</Badge>
                    ) : e.kind === "blackout" ? (
                      <Badge tone="red">Change freeze</Badge>
                    ) : (
                      <Badge tone="blue">Maintenance window</Badge>
                    )}
                  </td>
                  <td className="max-w-lg">
                    {e.kind === "change" ? (
                      <>
                        <Link href={`/tickets/${e.number}`} className="font-mono text-xs font-medium">
                          {e.number}
                        </Link>{" "}
                        {e.title}
                        <div className="text-xs text-slate-500">
                          {[e.changeType && humanize(e.changeType), e.risk && `risk ${e.risk}`, e.assignee].filter(Boolean).join(" · ")}
                        </div>
                      </>
                    ) : (
                      <>
                        <span className={e.kind === "blackout" ? "font-medium text-red-800" : undefined}>{e.title}</span>
                        {e.description && <div className="prose-plain text-xs text-slate-500">{e.description}</div>}
                      </>
                    )}
                  </td>
                  <td>{e.kind === "change" ? <StatusBadge status={e.status ?? ""} /> : <span className="text-xs text-slate-400">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
