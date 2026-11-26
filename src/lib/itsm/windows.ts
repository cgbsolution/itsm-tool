/**
 * Maintenance windows and change freezes (blackouts), with simple recurrence.
 * Used to block changes and patch deployments during a freeze and to time
 * deployments into the next maintenance window.
 */
import { q, type Db, pool } from "@/lib/db"

export type WindowRow = {
  id: string
  name: string
  description: string | null
  kind: "maintenance" | "blackout"
  applies_to: "all" | "changes" | "patches"
  starts_at: Date
  ends_at: Date
  recurrence: "none" | "daily" | "weekly" | "monthly"
  recurrence_until: Date | null
  is_active: boolean
}

export async function windowsFor(tenantId: string, scope: "changes" | "patches" | "all", db: Db = pool()): Promise<WindowRow[]> {
  return q<WindowRow>(
    `select id, name, description, kind, applies_to, starts_at, ends_at, recurrence, recurrence_until, is_active
       from maintenance_windows
      where tenant_id = $1 and is_active and (applies_to = 'all' or applies_to = $2 or $2 = 'all')
      order by starts_at`,
    [tenantId, scope],
    db
  )
}

function step(d: Date, recurrence: WindowRow["recurrence"], n: number): Date {
  const x = new Date(d)
  if (recurrence === "daily") x.setUTCDate(x.getUTCDate() + n)
  else if (recurrence === "weekly") x.setUTCDate(x.getUTCDate() + 7 * n)
  else if (recurrence === "monthly") x.setUTCMonth(x.getUTCMonth() + n)
  return x
}

/** Occurrences of a window that overlap [from, to). */
export function occurrences(w: WindowRow, from: Date, to: Date, max = 500): { start: Date; end: Date }[] {
  const start = new Date(w.starts_at)
  const duration = new Date(w.ends_at).getTime() - start.getTime()
  if (w.recurrence === "none") {
    const end = new Date(start.getTime() + duration)
    return end > from && start < to ? [{ start, end }] : []
  }
  const until = w.recurrence_until ? new Date(w.recurrence_until) : null
  const out: { start: Date; end: Date }[] = []
  // jump close to `from` for daily/weekly to avoid long loops
  let i = 0
  if (w.recurrence !== "monthly" && from > start) {
    const period = (w.recurrence === "daily" ? 1 : 7) * 86_400_000
    i = Math.max(0, Math.floor((from.getTime() - start.getTime() - duration) / period))
  }
  for (let guard = 0; guard < 5000 && out.length < max; guard++, i++) {
    const s = step(start, w.recurrence, i)
    if (until && s > until) break
    if (s >= to) break
    const e = new Date(s.getTime() + duration)
    if (e > from) out.push({ start: s, end: e })
  }
  return out
}

/** The first freeze that overlaps [start, end), if any. */
export function overlapsBlackout(windows: WindowRow[], start: Date, end: Date): WindowRow | null {
  for (const w of windows) {
    if (w.kind !== "blackout") continue
    if (occurrences(w, start, end, 1).length) return w
  }
  return null
}

/** Whether `at` falls inside a maintenance window (when any are defined for the scope). */
export function insideMaintenance(windows: WindowRow[], at: Date, windowId?: string | null): boolean {
  const list = windows.filter((w) => w.kind === "maintenance" && (!windowId || w.id === windowId))
  if (list.length === 0) return !windowId
  return list.some((w) => occurrences(w, at, new Date(at.getTime() + 1), 1).length > 0)
}

/** Start of the next occurrence of a maintenance window after `after` (or now if inside one). */
export function nextMaintenanceStart(windows: WindowRow[], after: Date, windowId?: string | null): Date | null {
  const list = windows.filter((w) => w.kind === "maintenance" && (!windowId || w.id === windowId))
  let best: Date | null = null
  const horizon = new Date(after.getTime() + 400 * 86_400_000)
  for (const w of list) {
    const occ = occurrences(w, after, horizon, 1)[0]
    if (!occ) continue
    const s = occ.start < after ? after : occ.start
    if (!best || s < best) best = s
  }
  return best
}

/** Calendar entries (expanded occurrences) for a date range. */
export function expand(windows: WindowRow[], from: Date, to: Date) {
  return windows
    .flatMap((w) => occurrences(w, from, to).map((o) => ({ ...o, window: w })))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
}
