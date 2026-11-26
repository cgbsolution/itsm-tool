/**
 * SLA clock maths: business-hours calendars with time zone, work days and
 * holidays. Ported unchanged in behaviour from the legacy helpdesk
 * (src/lib/itsm.ts, addSlaMinutes / slaMinutesBetween), plus helpers.
 * Pure functions, no I/O.
 */

export type WorkCalendar = {
  timezone: string
  /** 0 = Sunday … 6 = Saturday */
  work_days: number[]
  /** "HH:MM" or "HH:MM:SS" */
  work_start: string
  work_end: string
  /** "YYYY-MM-DD" in the calendar's time zone */
  holidays: string[]
}

const MINUTE = 60_000
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    })
    formatters.set(tz, f)
  }
  return f
}

/** Wall-clock parts of an instant in a time zone. */
export function zoned(ms: number, tz: string) {
  const parts: Record<string, string> = {}
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  }
}

/** How far the zone is ahead of UTC at an instant, in ms. */
function offsetAt(ms: number, tz: string) {
  const z = zoned(ms, tz)
  return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s) - Math.floor(ms / 1000) * 1000
}

/** The instant a wall-clock time happens in a time zone. */
export function wallToInstant(y: number, m: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  const first = guess - offsetAt(guess, tz)
  return guess - offsetAt(first, tz)
}

function hm(v: string) {
  const [h, m] = v.split(":").map(Number)
  return { h: h || 0, m: m || 0 }
}

function pad(n: number) {
  return String(n).padStart(2, "0")
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Working windows [start, end) as instants, one per day from the day containing `fromMs`. */
function* workWindows(fromMs: number, cal: WorkCalendar) {
  const tz = isValidTimeZone(cal.timezone) ? cal.timezone : "UTC"
  const start = hm(cal.work_start)
  const end = hm(cal.work_end)
  const days = new Set(cal.work_days)
  const holidays = new Set(cal.holidays)
  const first = zoned(fromMs, tz)
  for (let i = 0; i < 3700; i++) {
    const day = new Date(Date.UTC(first.y, first.m - 1, first.d + i))
    const y = day.getUTCFullYear()
    const m = day.getUTCMonth() + 1
    const d = day.getUTCDate()
    if (!days.has(day.getUTCDay())) continue
    if (holidays.has(`${y}-${pad(m)}-${pad(d)}`)) continue
    yield {
      start: wallToInstant(y, m, d, start.h, start.m, tz),
      end: wallToInstant(y, m, d, end.h, end.m, tz),
    }
  }
}

function hasWorkingTime(cal: WorkCalendar) {
  const s = hm(cal.work_start)
  const e = hm(cal.work_end)
  return cal.work_days.length > 0 && e.h * 60 + e.m > s.h * 60 + s.m
}

/**
 * The instant `minutes` of SLA time after `from`.
 * Without a calendar the clock runs around the clock; with one it only runs in working hours.
 */
export function addSlaMinutes(from: Date, minutes: number, cal: WorkCalendar | null): Date {
  const fromMs = from.getTime()
  if (!cal || !hasWorkingTime(cal)) return new Date(fromMs + minutes * MINUTE)
  let remaining = Math.max(0, minutes) * MINUTE
  for (const w of workWindows(fromMs, cal)) {
    const begin = Math.max(w.start, fromMs)
    if (begin >= w.end) continue
    const available = w.end - begin
    if (remaining <= available) return new Date(begin + remaining)
    remaining -= available
  }
  return new Date(fromMs + minutes * MINUTE)
}

/** SLA minutes that pass between two instants (0 if `to` is not after `from`). */
export function slaMinutesBetween(from: Date, to: Date, cal: WorkCalendar | null): number {
  const a = from.getTime()
  const b = to.getTime()
  if (b <= a) return 0
  if (!cal || !hasWorkingTime(cal)) return (b - a) / MINUTE
  let total = 0
  for (const w of workWindows(a, cal)) {
    if (w.start >= b) break
    const s = Math.max(w.start, a)
    const e = Math.min(w.end, b)
    if (e > s) total += e - s
  }
  return total / MINUTE
}

/** "1 h 30 min", "2 d 4 h", "15 min". */
export function formatMinutes(total: number): string {
  const m = Math.round(Math.abs(total))
  if (m < 60) return `${m} min`
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  return [d && `${d} d`, h && `${h} h`, !d && mm && `${mm} min`].filter(Boolean).join(" ") || "0 min"
}

/**
 * New deadline after a pause (hold, approval wait, resolved): the SLA time
 * that was left when the pause started is given back from `now`. An already
 * missed deadline stays missed. (Legacy deadlineAfterHold, generalised.)
 */
export function deadlineAfterPause(due: Date, pausedAt: Date, now: Date, cal: WorkCalendar | null): Date {
  if (due <= pausedAt) return due
  const left = slaMinutesBetween(pausedAt, due, cal)
  return addSlaMinutes(now, left, cal)
}
