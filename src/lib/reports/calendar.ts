/**
 * Change calendar: changes by planned window plus maintenance windows and
 * change freezes, laid out on a month grid in the tenant time zone.
 */
import { q } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { forbidden } from "@/lib/errors"
import { expand, windowsFor } from "@/lib/itsm/windows"
import { addDays, dayStart, daysSpanned, firstOfMonth, monthGrid, shiftMonth, type Month } from "@/lib/reports/helpers"

export type CalendarEvent = {
  key: string
  kind: "change" | "maintenance" | "blackout"
  title: string
  start: Date
  end: Date | null
  number?: string
  status?: string
  changeType?: string | null
  risk?: string | null
  assignee?: string | null
  description?: string | null
}

export async function changeCalendar(actor: Actor, month: Month, opts: { includeClosed?: boolean } = {}) {
  if (!actor.permissions.has("change.manage")) throw forbidden()
  const tz = actor.tenant.timezone
  const weeks = monthGrid(month)
  const gridFrom = weeks[0][0]
  const gridTo = weeks[weeks.length - 1][6]
  const from = dayStart(gridFrom, tz)
  const to = dayStart(addDays(gridTo, 1), tz)
  const monthFrom = dayStart(firstOfMonth(month), tz)
  const monthTo = dayStart(firstOfMonth(shiftMonth(month, 1)), tz)

  const [changes, windows] = await Promise.all([
    q<{
      id: string
      number: string
      subject: string
      status: string
      change_type: string | null
      risk: string | null
      planned_start: Date
      planned_end: Date | null
      assignee_name: string | null
    }>(
      `select t.id, t.number, t.subject, t.status, t.change_type, t.risk, t.planned_start, t.planned_end, a.full_name as assignee_name
         from tickets t left join users a on a.id = t.assignee_id
        where t.tenant_id = $1 and t.ticket_type = 'change' and t.planned_start is not null
          and t.planned_start < $3 and coalesce(t.planned_end, t.planned_start + interval '1 minute') > $2
          and ($4::boolean or t.status not in ('cancelled', 'rejected'))
        order by t.planned_start, t.number
        limit 2000`,
      [actor.tenantId, from, to, !!opts.includeClosed]
    ),
    windowsFor(actor.tenantId, "changes"),
  ])

  const events: CalendarEvent[] = [
    ...changes.map((c) => ({
      key: `c:${c.id}`,
      kind: "change" as const,
      title: c.subject,
      start: new Date(c.planned_start),
      end: c.planned_end ? new Date(c.planned_end) : null,
      number: c.number,
      status: c.status,
      changeType: c.change_type,
      risk: c.risk,
      assignee: c.assignee_name,
    })),
    ...expand(windows, from, to).map((o) => ({
      key: `w:${o.window.id}:${o.start.getTime()}`,
      kind: o.window.kind,
      title: o.window.name,
      start: o.start,
      end: o.end,
      description: o.window.description,
    })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime() || (a.kind === "blackout" ? -1 : b.kind === "blackout" ? 1 : 0))

  const byDay: Record<string, CalendarEvent[]> = {}
  for (const e of events) {
    for (const d of daysSpanned(e.start, e.end, tz, { from: gridFrom, to: gridTo })) (byDay[d] ??= []).push(e)
  }
  const agenda = events.filter((e) => e.start < monthTo && (e.end ?? new Date(e.start.getTime() + 60_000)) > monthFrom)
  const freezeDays = new Set(
    events.filter((e) => e.kind === "blackout").flatMap((e) => daysSpanned(e.start, e.end, tz, { from: gridFrom, to: gridTo }))
  )
  return { weeks, byDay, agenda, freezeDays: [...freezeDays], tz }
}
