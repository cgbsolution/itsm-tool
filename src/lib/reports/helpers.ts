/**
 * Pure helpers for reports and the change calendar: date ranges in the tenant
 * time zone, series filling, percentages, ageing buckets, SLA summaries and
 * month grids. No I/O (unit-tested).
 */
import { zoned, wallToInstant, isValidTimeZone } from "@/lib/itsm/clock"

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/* ── calendar dates ("YYYY-MM-DD", no time zone) ─────────────────────── */

export function isYmd(v: unknown): v is string {
  if (typeof v !== "string") return false
  const m = YMD_RE.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

function ymdToUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number)
  return Date.UTC(y, m - 1, d)
}

function utcToYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(ymd: string, n: number): string {
  return utcToYmd(ymdToUtc(ymd) + n * DAY_MS)
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((ymdToUtc(b) - ymdToUtc(a)) / DAY_MS)
}

/** 0 = Monday … 6 = Sunday */
export function isoWeekday(ymd: string): number {
  return (new Date(ymdToUtc(ymd)).getUTCDay() + 6) % 7
}

/** The Monday of the week containing ymd. */
export function weekStart(ymd: string): string {
  return addDays(ymd, -isoWeekday(ymd))
}

function safeTz(tz: string): string {
  return isValidTimeZone(tz) ? tz : "UTC"
}

/** The calendar date of an instant in a time zone. */
export function localDay(at: Date | number, tz: string): string {
  const z = zoned(typeof at === "number" ? at : at.getTime(), safeTz(tz))
  return `${z.y}-${String(z.m).padStart(2, "0")}-${String(z.d).padStart(2, "0")}`
}

/** Midnight at the start of a calendar date in a time zone. */
export function dayStart(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(wallToInstant(y, m, d, 0, 0, safeTz(tz)))
}

/* ── report date range ───────────────────────────────────────────────── */

export const DEFAULT_RANGE_DAYS = 30
export const MAX_RANGE_DAYS = 731

export type Granularity = "day" | "week"

export type ReportRange = {
  /** first day, inclusive */
  from: string
  /** last day, inclusive */
  to: string
  tz: string
  /** instants: [start, end) */
  start: Date
  end: Date
  days: number
  granularity: Granularity
}

/**
 * From ?from=&to= (calendar dates in the tenant zone). Default: the last 30
 * days including today. Swapped when reversed; at most two years.
 */
export function resolveRange(input: { from?: unknown; to?: unknown }, tz: string, now: Date = new Date()): ReportRange {
  const zone = safeTz(tz)
  const today = localDay(now, zone)
  let to = isYmd(input.to) ? input.to : today
  let from = isYmd(input.from) ? input.from : addDays(to, -(DEFAULT_RANGE_DAYS - 1))
  if (daysBetween(from, to) < 0) [from, to] = [to, from]
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1))
  const days = daysBetween(from, to) + 1
  return {
    from,
    to,
    tz: zone,
    start: dayStart(from, zone),
    end: dayStart(addDays(to, 1), zone),
    days,
    granularity: days > 92 ? "week" : "day",
  }
}

/** Bucket keys of a range: each day, or each week's Monday. */
export function seriesKeys(range: Pick<ReportRange, "from" | "to" | "granularity">): string[] {
  const out: string[] = []
  if (range.granularity === "week") {
    for (let d = weekStart(range.from); daysBetween(d, range.to) >= 0; d = addDays(d, 7)) out.push(d)
  } else {
    for (let d = range.from; daysBetween(d, range.to) >= 0; d = addDays(d, 1)) out.push(d)
  }
  return out
}

/** Joins rows onto every key, with 0 where a key has no row. */
export function fillSeries(keys: string[], rows: { key: string; n: number }[]): { key: string; n: number }[] {
  const map = new Map<string, number>()
  for (const r of rows) map.set(String(r.key), (map.get(String(r.key)) ?? 0) + Number(r.n))
  return keys.map((key) => ({ key, n: map.get(key) ?? 0 }))
}

/* ── numbers ─────────────────────────────────────────────────────────── */

/** part / whole as a percentage with one decimal, or null when whole is 0. */
export function percent(part: number, whole: number): number | null {
  if (!whole) return null
  return Math.round((part / whole) * 1000) / 10
}

export function formatPercent(v: number | null): string {
  return v === null ? "—" : `${Number.isInteger(v) ? v : v.toFixed(1)}%`
}

/** Mean of group means weighted by their counts (null without data). */
export function weightedMean(rows: { n: number; mean: number | null }[]): number | null {
  let total = 0
  let sum = 0
  for (const r of rows) {
    if (r.mean === null || r.mean === undefined || !r.n) continue
    total += r.n
    sum += r.mean * r.n
  }
  return total ? sum / total : null
}

/* ── backlog ageing ──────────────────────────────────────────────────── */

/** Upper bounds in hours, as passed to SQL width_bucket(). */
export const AGE_THRESHOLDS_HOURS = [24, 72, 168, 720] as const
export const AGE_LABELS = ["< 1 day", "1–3 days", "3–7 days", "7–30 days", "> 30 days"] as const

/** Same semantics as width_bucket(hours, thresholds): 0 … thresholds.length. */
export function ageBucketIndex(hours: number): number {
  let i = 0
  for (const t of AGE_THRESHOLDS_HOURS) if (hours >= t) i++
  return i
}

export function ageingBuckets(rows: { bucket: number; n: number }[]): { label: string; n: number }[] {
  const counts: number[] = AGE_LABELS.map(() => 0)
  for (const r of rows) {
    const i = Math.min(Math.max(Number(r.bucket), 0), AGE_LABELS.length - 1)
    counts[i] += Number(r.n)
  }
  return AGE_LABELS.map((label, i) => ({ label, n: counts[i] }))
}

/* ── SLA compliance ──────────────────────────────────────────────────── */

export type SlaRow = { kind: string; priority: string; met: number; breached: number }
export type Compliance = { met: number; breached: number; total: number; pct: number | null }

function comp(met: number, breached: number): Compliance {
  return { met, breached, total: met + breached, pct: percent(met, met + breached) }
}

/** Met vs breached per kind, and per priority for each kind. */
export function summarizeSla(rows: SlaRow[], priorities: readonly string[]) {
  const byKind: Record<string, Compliance> = {}
  const byPriority: Record<string, Record<string, Compliance>> = {}
  for (const kind of ["response", "resolution"]) {
    const ks = rows.filter((r) => r.kind === kind)
    byKind[kind] = comp(
      ks.reduce((s, r) => s + Number(r.met), 0),
      ks.reduce((s, r) => s + Number(r.breached), 0)
    )
    for (const p of priorities) {
      const ps = ks.filter((r) => r.priority === p)
      ;(byPriority[p] ??= {})[kind] = comp(
        ps.reduce((s, r) => s + Number(r.met), 0),
        ps.reduce((s, r) => s + Number(r.breached), 0)
      )
    }
  }
  return { byKind, byPriority }
}

/* ── change success ──────────────────────────────────────────────────── */

export const CHANGE_OUTCOME_ORDER = ["successful", "partially_successful", "failed", "backed_out"] as const

export function changeSuccess(rows: { outcome: string; n: number }[]) {
  const total = rows.reduce((s, r) => s + Number(r.n), 0)
  const count = (o: string) => rows.filter((r) => r.outcome === o).reduce((s, r) => s + Number(r.n), 0)
  return {
    total,
    successRate: percent(count("successful"), total),
    rows: CHANGE_OUTCOME_ORDER.map((outcome) => ({ outcome, n: count(outcome), pct: percent(count(outcome), total) })),
  }
}

/* ── change calendar ─────────────────────────────────────────────────── */

export type Month = { year: number; month: number }

export function monthKey(m: Month): string {
  return `${m.year}-${String(m.month).padStart(2, "0")}`
}

/** ?month=YYYY-MM, else the current month in the zone. */
export function parseMonth(v: unknown, tz: string, now: Date = new Date()): Month {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})$/.exec(v) : null
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1970 && +m[1] <= 2999) return { year: +m[1], month: +m[2] }
  const [y, mo] = localDay(now, tz).split("-").map(Number)
  return { year: y, month: mo }
}

export function shiftMonth(m: Month, delta: number): Month {
  const i = m.year * 12 + (m.month - 1) + delta
  return { year: Math.floor(i / 12), month: (i % 12) + 1 }
}

export function firstOfMonth(m: Month): string {
  return `${monthKey(m)}-01`
}

/** Weeks (Monday first) covering the month, as arrays of seven dates. */
export function monthGrid(m: Month): string[][] {
  const first = firstOfMonth(m)
  const last = addDays(firstOfMonth(shiftMonth(m, 1)), -1)
  const weeks: string[][] = []
  for (let d = weekStart(first); daysBetween(d, last) >= 0; d = addDays(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)))
  }
  return weeks
}

/**
 * Calendar dates (in the zone) that [start, end) touches, clipped to
 * [clip.from, clip.to] when given. A zero-length or missing end counts as the
 * start day only.
 */
export function daysSpanned(start: Date, end: Date | null, tz: string, clip?: { from: string; to: string }): string[] {
  let first = localDay(start, tz)
  const lastMs = end && end.getTime() > start.getTime() ? end.getTime() - 1 : start.getTime()
  let last = localDay(lastMs, tz)
  if (clip) {
    if (daysBetween(first, clip.from) > 0) first = clip.from
    if (daysBetween(clip.to, last) > 0) last = clip.to
  }
  const out: string[] = []
  for (let d = first; daysBetween(d, last) >= 0 && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}
