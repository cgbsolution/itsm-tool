/**
 * Pure validation helpers for the administration services (no I/O).
 * Each parser throws an AppError with a message the admin can act on.
 */
import { AppError } from "@/lib/errors"
import { PERMISSIONS, SYSTEM_ROLES, isPermission, type Permission } from "@/lib/auth/permissions"
import { TICKET_TYPES, type TicketType } from "@/lib/itsm/vocab"

/* ── values from forms ─────────────────────────────────────────────────── */

/** A repeated form value (checkboxes, multi-select) as a list of strings. */
export function list(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return []
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean)
}

/** Optional text: trimmed, null when empty, refused when longer than `max`. */
export function optionalText(v: unknown, max: number, label: string): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  if (!s) return null
  if (s.length > max) throw new AppError(`${label}: use at most ${max} characters`)
  return s
}

export function requiredText(v: unknown, max: number, label: string): string {
  const s = optionalText(v, max, label)
  if (!s) throw new AppError(`${label} is required`)
  return s
}

/** Whole number within bounds (the form shows the same bounds). */
export function wholeNumber(v: unknown, label: string, min: number, max: number): number {
  const s = String(v ?? "").trim()
  if (!/^-?\d+$/.test(s)) throw new AppError(`${label} must be a whole number`)
  const n = Number(s)
  if (n < min || n > max) throw new AppError(`${label} must be between ${min} and ${max}`)
  return n
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function normalizeEmail(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase()
  if (!s) throw new AppError("Email is required")
  if (s.length > 320 || !EMAIL_RE.test(s)) throw new AppError("Enter a valid email address")
  return s
}

export function optionalEmail(v: unknown, label = "Email"): string | null {
  const s = String(v ?? "").trim().toLowerCase()
  if (!s) return null
  if (s.length > 320 || !EMAIL_RE.test(s)) throw new AppError(`${label}: enter a valid email address`)
  return s
}

const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** "Example.com", "@example.com" or "https://example.com/" → "example.com". */
export function optionalDomain(v: unknown): string | null {
  let s = String(v ?? "").trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^https?:\/\//, "").replace(/^@/, "").replace(/\/+$/, "")
  if (!DOMAIN_RE.test(s)) throw new AppError("Enter a domain like example.com")
  return s
}

/* ── roles and permissions ─────────────────────────────────────────────── */

export const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/
/** Keys a custom role may not use: the system roles and the background-job actor. */
const RESERVED_ROLE_KEYS = new Set<string>([...Object.keys(SYSTEM_ROLES), "system"])

export function roleKeyProblem(key: string): string | null {
  if (!key) return "Enter a key"
  if (!ROLE_KEY_RE.test(key)) return "The key must start with a lowercase letter and be 2 to 41 lowercase letters, digits or underscores"
  if (RESERVED_ROLE_KEYS.has(key)) return `"${key}" is reserved for a built-in role`
  return null
}

/** Permissions a custom role may hold: known keys, never admin.tenants. */
export function cleanPermissions(values: unknown): Permission[] {
  const out = new Set<Permission>()
  for (const v of list(values)) if (isPermission(v) && v !== "admin.tenants") out.add(v)
  return [...out].sort()
}

const GROUP_LABELS: Record<string, string> = {
  ticket: "Tickets",
  problem: "Problems",
  change: "Changes",
  catalog: "Service catalog",
  kb: "Knowledge base",
  cmdb: "CMDB",
  endpoint: "Endpoints",
  patch: "Patches",
  report: "Reports",
  audit: "Audit",
  admin: "Administration",
}

/** Permissions grouped by their prefix ("ticket.", "cmdb." …), for checkbox lists. */
export function permissionGroups(opts: { includeTenants?: boolean } = {}) {
  const groups: { prefix: string; label: string; items: { key: Permission; description: string }[] }[] = []
  for (const [key, description] of Object.entries(PERMISSIONS) as [Permission, string][]) {
    if (key === "admin.tenants" && !opts.includeTenants) continue
    const prefix = key.split(".")[0]
    let g = groups.find((x) => x.prefix === prefix)
    if (!g) {
      g = { prefix, label: GROUP_LABELS[prefix] ?? prefix, items: [] }
      groups.push(g)
    }
    g.items.push({ key, description })
  }
  return groups
}

/* ── ITSM configuration ────────────────────────────────────────────────── */

export const MAX_TARGET_MINUTES = 525_600 // 365 days, the schema's limit

/**
 * An SLA target entered as hours + minutes → minutes.
 * Empty parts count as 0; minutes must be 0–59; the total 1 minute to 365 days.
 */
export function parseDuration(hours: unknown, minutes: unknown, label: string): number {
  const hs = String(hours ?? "").trim()
  const ms = String(minutes ?? "").trim()
  if (hs && !/^\d+$/.test(hs)) throw new AppError(`${label}: hours must be a whole number`)
  if (ms && !/^\d+$/.test(ms)) throw new AppError(`${label}: minutes must be a whole number`)
  const h = hs ? Number(hs) : 0
  const m = ms ? Number(ms) : 0
  if (m > 59) throw new AppError(`${label}: minutes must be between 0 and 59`)
  const total = h * 60 + m
  if (total < 1) throw new AppError(`${label}: enter at least 1 minute`)
  if (total > MAX_TARGET_MINUTES) throw new AppError(`${label}: the longest target is 8760 hours (365 days)`)
  return total
}

export function splitMinutes(total: number): { hours: number; minutes: number } {
  const t = Math.max(0, Math.round(total))
  return { hours: Math.floor(t / 60), minutes: t % 60 }
}

function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Holidays, one per line: "YYYY-MM-DD", optionally followed by a name (ignored).
 * Blank lines and lines starting with # are skipped. Returns sorted unique dates.
 */
export function parseHolidays(text: unknown): string[] {
  const out = new Set<string>()
  const lines = String(text ?? "").split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith("#")) return
    const m = /^(\d{4})-(\d{2})-(\d{2})(?=$|[\s,;:–—-])/.exec(line)
    if (!m) throw new AppError(`Holidays, line ${i + 1}: start the line with a date like 2026-12-25`)
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (!isRealDate(y, mo, d) || y < 1970 || y > 2200) throw new AppError(`Holidays, line ${i + 1}: ${m[0]} is not a real date`)
    out.add(m[0])
  })
  if (out.size > 1000) throw new AppError("Holidays: list at most 1000 dates")
  return [...out].sort()
}

/** "HH:MM" (24-hour) or throws. Seconds are dropped. */
export function parseTimeOfDay(v: unknown, label: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(v ?? "").trim())
  if (!m) throw new AppError(`${label}: enter a time like 09:00`)
  return `${m[1].padStart(2, "0")}:${m[2]}`
}

/** Work days from checkboxes (0 = Sunday … 6 = Saturday). */
export function parseWorkDays(values: unknown): number[] {
  const days = new Set<number>()
  for (const v of list(values)) {
    if (!/^[0-6]$/.test(v)) throw new AppError("Work days: unknown day")
    days.add(Number(v))
  }
  if (days.size === 0) throw new AppError("Choose at least one work day")
  return [...days].sort((a, b) => a - b)
}

/** Record types from checkboxes; none or all of them means "every type" (null). */
export function parseTicketTypes(values: unknown): TicketType[] | null {
  const chosen = new Set<TicketType>()
  for (const v of list(values)) {
    if (!(TICKET_TYPES as readonly string[]).includes(v)) throw new AppError(`Unknown record type "${v}"`)
    chosen.add(v as TicketType)
  }
  if (chosen.size === 0 || chosen.size === TICKET_TYPES.length) return null
  return TICKET_TYPES.filter((t) => chosen.has(t))
}

/** Select options, one per line: trimmed, blank lines dropped, duplicates refused. */
export function parseOptions(text: unknown): string[] {
  const out: string[] = []
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const s = raw.trim()
    if (!s) continue
    if (s.length > 200) throw new AppError(`Option "${s.slice(0, 30)}…" is too long (200 characters at most)`)
    if (out.includes(s)) throw new AppError(`Option "${s}" is listed twice`)
    out.push(s)
  }
  if (out.length > 200) throw new AppError("List at most 200 options")
  return out
}

export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/

export function fieldKeyProblem(key: string): string | null {
  if (!key) return "Enter a key"
  if (!FIELD_KEY_RE.test(key)) return "The key must start with a lowercase letter and use at most 41 lowercase letters, digits or underscores"
  return null
}

/** {{placeholders}} used in a template text. */
export function placeholdersIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) out.add(m[1])
  return [...out]
}
