/** Pure value helpers for CI fields: dates, numbers, booleans, warranty state. */

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * Parses YYYY-MM-DD or DD/MM/YYYY (also DD-MM-YYYY and DD.MM.YYYY) into
 * YYYY-MM-DD. Empty input gives null; anything else that is not a real date throws.
 */
export function parseDateInput(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const v = String(raw).trim()
  if (!v) return null
  let iso: string | null = null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v)
  if (m) iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v)
  if (m) iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
  if (!iso || !isIsoDate(iso)) throw new Error(`"${v.slice(0, 40)}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`)
  return iso
}

/** A number from user input ("1,200.50" and "1200" are fine). Empty gives null. */
export function parseNumberInput(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error("Not a number")
    return raw
  }
  const v = String(raw).trim().replace(/[\s,](?=\d{3}\b)/g, "")
  if (!v) return null
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`"${String(raw).slice(0, 40)}" is not a number`)
  return Number(v)
}

export function parseIntInput(raw: unknown, min: number, max: number): number | null {
  const n = parseNumberInput(raw)
  if (n === null) return null
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`"${String(raw).slice(0, 40)}" must be a whole number from ${min} to ${max}`)
  return n
}

/** yes/no, true/false, 1/0, y/n, on/off. Empty gives null. */
export function parseBoolInput(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === "boolean") return raw
  const v = String(raw).trim().toLowerCase()
  if (!v) return null
  if (["yes", "y", "true", "1", "on"].includes(v)) return true
  if (["no", "n", "false", "0", "off"].includes(v)) return false
  throw new Error(`"${String(raw).slice(0, 40)}" is not yes or no`)
}

/** YYYY-MM-DD plus whole years (29 Feb rolls to 28 Feb). */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const target = y + years
  const last = new Date(Date.UTC(target, m, 0)).getUTCDate()
  return `${target}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10))
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

export type WarrantyState = { state: "none" | "ok" | "expiring" | "expired"; days: number | null }

/** Expired before today, expiring within 30 days, else ok. */
export function warrantyState(expiry: string | null | undefined, today: string, windowDays = 30): WarrantyState {
  if (!expiry || !isIsoDate(expiry)) return { state: "none", days: null }
  const days = daysBetween(today, expiry)
  if (days < 0) return { state: "expired", days }
  if (days <= windowDays) return { state: "expiring", days }
  return { state: "ok", days }
}

/** Cleans a free-text value: trims, drops control characters, caps the length. Empty gives null. */
export function cleanText(raw: unknown, max = 200): string | null {
  if (raw === undefined || raw === null) return null
  const v = String(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
  return v ? v.slice(0, max) : null
}
