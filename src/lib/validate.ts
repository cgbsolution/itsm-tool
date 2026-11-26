import type { z } from "zod"
import { AppError } from "@/lib/errors"
import { wallToInstant, isValidTimeZone } from "@/lib/itsm/clock"

/** Parses with zod; the first problem becomes a user-facing AppError. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    const issue = r.error.issues[0]
    const field = issue.path.length ? `${issue.path.join(".")}: ` : ""
    const msg = issue.message
    throw new AppError(/^(Invalid|Expected|Too)/.test(msg) ? `${field}${msg}` : msg)
  }
  return r.data
}

/** FormData → plain object. Empty strings become undefined; repeated keys become arrays. */
export function formObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of fd.entries()) {
    if (key.startsWith("$ACTION")) continue
    if (typeof value !== "string") continue
    const v = value.trim() === "" ? undefined : value
    if (v === undefined) continue
    if (key.endsWith("[]")) {
      const k = key.slice(0, -2)
      out[k] = [...((out[k] as unknown[]) ?? []), v]
    } else if (key in out) {
      out[key] = [...(Array.isArray(out[key]) ? (out[key] as unknown[]) : [out[key]]), v]
    } else {
      out[key] = v
    }
  }
  return out
}

/** Values of keys "prefix.name" as { name: value }. */
export function prefixed(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (k.startsWith(prefix + ".")) out[k.slice(prefix.length + 1)] = v
  return out
}

/** "2026-11-27T10:30" (a datetime-local input) in a time zone → Date. */
export function parseLocalDateTime(value: unknown, timeZone: string): Date | null {
  if (value === undefined || value === null || value === "") return null
  if (value instanceof Date) return value
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value))
  if (!m) {
    const d = new Date(String(value))
    if (Number.isNaN(d.getTime())) throw new AppError(`"${String(value)}" is not a valid date and time`)
    return d
  }
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC"
  return new Date(wallToInstant(+m[1], +m[2], +m[3], +m[4], +m[5], tz))
}

/** Date → "YYYY-MM-DDTHH:MM" wall time in a zone (for datetime-local inputs). */
export function toLocalInput(date: Date | string | null | undefined, timeZone: string): string {
  if (!date) return ""
  const d = new Date(date)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function str(v: unknown, max = 500): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

export function bool(v: unknown): boolean {
  return v === true || v === "on" || v === "true" || v === "1"
}

export function int(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = Number.parseInt(String(v ?? ""), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
