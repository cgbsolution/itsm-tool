/**
 * Agent protocol v1 (docs/AGENT_PROTOCOL.md): request schemas and pure helpers.
 * No I/O here, so it is unit-tested directly.
 *
 * Validation is strict on structure (types, list sizes, identifiers) and
 * forgiving on cosmetics: long free text is truncated, unknown classification
 * or severity values fall back to "other" / "unspecified", and a single object
 * where a list is expected is accepted as a one-item list (PowerShell 5.1
 * ConvertTo-Json collapses one-element arrays).
 */
import { z } from "zod"
import { AppError } from "@/lib/errors"
import { CLASSIFICATIONS, OS_FAMILIES, SCAN_SOURCES, SEVERITIES, type Classification, type Severity } from "@/lib/endpoints/vocab"

export const POLL_INTERVAL_SECONDS = 60
export const MAX_WAIT_SECONDS = 30
export const DEFAULT_WAIT_SECONDS = 25
export const OUTPUT_MAX_BYTES = 64 * 1024

/** Request body caps (bytes). */
export const BODY_LIMITS = {
  enroll: 64 * 1024,
  heartbeat: 64 * 1024,
  inventory: 16 * 1024 * 1024,
  patches: 16 * 1024 * 1024,
  job: 1024 * 1024,
} as const

export const LIMITS = { software: 20_000, available: 5_000, installed: 10_000, results: 5_000 } as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* ── small pure helpers ────────────────────────────────────────────────── */

/** Removes NUL characters (PostgreSQL text and jsonb refuse them) and trims to `max` characters. */
export function cleanText(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/\u0000/g, "").trim().slice(0, max)
}

/** Truncates to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(v: string, maxBytes = OUTPUT_MAX_BYTES): string {
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/\u0000/g, "")
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end-- // step back to a character boundary
  return buf.subarray(0, end).toString("utf8")
}

/** Deep copy of JSON-like data with NUL characters removed from strings (for jsonb). */
export function cleanJson(v: unknown, depth = 0): unknown {
  if (depth > 20) return null
  // eslint-disable-next-line no-control-regex
  if (typeof v === "string") return v.replace(/\u0000/g, "")
  if (Array.isArray(v)) return v.map((x) => cleanJson(x, depth + 1))
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    // eslint-disable-next-line no-control-regex
    for (const [k, x] of Object.entries(v)) out[k.replace(/\u0000/g, "")] = cleanJson(x, depth + 1)
    return out
  }
  return v
}

/** Accepts YYYY-MM-DD, YYYYMMDD, ISO timestamps and PowerShell's "/Date(ms)/"; returns YYYY-MM-DD or null. */
export function normalizeDate(v: unknown): string | null {
  if (v === null || v === undefined) return null
  let d: Date | null = null
  if (typeof v === "number" && Number.isFinite(v)) d = new Date(v > 1e11 ? v : v * 1000)
  else if (typeof v === "string") {
    const s = v.trim()
    let m: RegExpExecArray | null
    if ((m = /^\/?Date\((-?\d+)(?:[+-]\d{4})?\)\/?$/.exec(s))) d = new Date(Number(m[1]))
    else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) d = new Date(s)
    else return null
    // reject impossible calendar dates such as 2026-02-31
    if (m && m.length === 4 && d && (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3])) return null
  } else return null
  if (!d || Number.isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  if (y < 1970 || y > 2100) return null
  return d.toISOString().slice(0, 10)
}

/** ISO timestamp → Date (null when missing or unparsable). */
export function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export function normalizeClassification(v: unknown): Classification {
  if (typeof v !== "string") return "other"
  let s = v.trim().toLowerCase().replace(/[\s_-]+/g, " ")
  s = s.replace(/ updates?$/, "").replace(/ packs?$/, "")
  if (s === "updates" || s === "update rollups" || s === "update rollup" || s === "service pack" || s === "service packs") s = "update"
  if (s === "drivers") s = "driver"
  if (s === "features" || s === "feature") s = "feature"
  if (s === "definitions") s = "definition"
  return (CLASSIFICATIONS as readonly string[]).includes(s) ? (s as Classification) : "other"
}

export function normalizeSeverity(v: unknown): Severity {
  if (typeof v !== "string") return "unspecified"
  const s = v.trim().toLowerCase()
  if (s === "high") return "important"
  if (s === "medium") return "moderate"
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : "unspecified"
}

/** Exit codes are int4; Windows HRESULTs often arrive unsigned (0x80240022 = 2149842978). */
export function toInt32(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  const n = Math.trunc(v)
  if (n > 2147483647 && n <= 4294967295) return n - 4294967296
  return Math.max(-2147483648, Math.min(2147483647, n))
}

/** `Authorization: Bearer <device_id>.<device_secret>` → parts, or null. */
export function parseDeviceAuth(header: string | null | undefined): { deviceId: string; secret: string } | null {
  if (!header) return null
  const m = /^Bearer\s+([^\s.]+)\.([A-Za-z0-9_-]+)$/i.exec(header.trim())
  if (!m) return null
  if (!UUID.test(m[1])) return null
  if (m[2].length < 16 || m[2].length > 256) return null
  return { deviceId: m[1].toLowerCase(), secret: m[2] }
}

/** `?wait=` of the long poll: 0…30 seconds, default 25. */
export function parseWait(v: string | null | undefined): number {
  if (v === null || v === undefined || v.trim() === "") return DEFAULT_WAIT_SECONDS
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_WAIT_SECONDS
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(n)))
}

/** Client address from proxy headers (display only; not used for security decisions beyond rate limiting). */
export function requestIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for")
  if (fwd) {
    const first = fwd.split(",")[0].trim()
    if (first) return first.slice(0, 64)
  }
  const real = headers.get("x-real-ip")?.trim()
  return real ? real.slice(0, 64) : null
}

/* ── zod building blocks ───────────────────────────────────────────────── */

const toList = (v: unknown) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v])

/** Optional free text: truncated, NUL-free, empty → null. */
const optText = (max: number) =>
  z.preprocess((v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v), z.string().nullish())
    .transform((v) => (v === null || v === undefined ? null : cleanText(v, max) || null))

const num = () =>
  z.preprocess((v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v === "" ? null : v), z.number().finite().nullish())
    .transform((v) => (v === undefined ? null : v))

const flag = () =>
  z.preprocess((v) => (v === "true" || v === 1 || v === "1" ? true : v === "false" || v === 0 || v === "0" ? false : v), z.boolean().nullish())
    .transform((v) => (v === undefined ? null : v))

/** List of short strings (addresses): one string accepted as a one-item list; missing → undefined (keep). */
const strList = (maxItems: number, maxLen: number) =>
  z.preprocess(
    (v) =>
      v === null || v === undefined
        ? undefined
        : toList(v)
            .filter((x): x is string => typeof x === "string" && x.trim() !== "")
            .map((x) => cleanText(x, 1000)),
    z.array(z.string().max(maxLen)).max(maxItems).optional()
  )

function listOf<T extends z.ZodType>(item: T, max: number) {
  return z.preprocess(toList, z.array(item).max(max, `Too many items (at most ${max})`))
}

const dateish = () => z.unknown().optional().transform(normalizeDate)
const externalId = () =>
  z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string())
    .transform((v) => cleanText(v, 1000))
    .pipe(z.string().min(1, "external_id is required").max(300))

/* ── request bodies ────────────────────────────────────────────────────── */

export const enrollSchema = z.object({
  token: z.string().trim().min(8).max(200),
  hostname: z.string().transform((v) => cleanText(v, 1000)).pipe(z.string().min(1, "hostname is required").max(255)),
  os_family: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(OS_FAMILIES)),
  os_name: optText(200),
  os_version: optText(100),
  arch: optText(50),
  agent_version: optText(50),
  serial_no: optText(200),
  mac_addresses: strList(64, 64),
})
export type EnrollInput = z.output<typeof enrollSchema>

export const heartbeatSchema = z.object({
  agent_version: optText(50),
  hostname: optText(255),
  logged_on_user: optText(255),
  uptime_seconds: num(),
  reboot_pending: flag(),
  ip_addresses: strList(128, 64),
})
export type HeartbeatInput = z.output<typeof heartbeatSchema>

const diskSchema = z.object({ name: optText(100), size_gb: num(), free_gb: num() })

export const inventorySchema = z.object({
  hardware: z
    .object({
      manufacturer: optText(200),
      model: optText(200),
      serial_no: optText(200),
      cpu: optText(300),
      cpu_cores: num(),
      ram_mb: num(),
      disks: listOf(diskSchema, 64),
    })
    .nullish(),
  os: z
    .object({
      name: optText(200),
      version: optText(100),
      build: optText(100),
      arch: optText(50),
      domain: optText(255),
      install_date: dateish(),
    })
    .nullish(),
  network: z.object({ mac_addresses: strList(64, 64), ip_addresses: strList(128, 64) }).nullish(),
  software: listOf(
    z.object({ name: optText(300), version: optText(200), publisher: optText(300), installed_on: dateish() }),
    LIMITS.software
  ),
})
export type InventoryInput = z.output<typeof inventorySchema>

const availableSchema = z.object({
  external_id: externalId(),
  kb: optText(50),
  title: optText(500),
  classification: z.unknown().optional().transform(normalizeClassification),
  severity: z.unknown().optional().transform(normalizeSeverity),
  version: optText(200),
  size_bytes: num(),
  reboot_required: flag(),
  release_date: dateish(),
  description: optText(4000),
  support_url: optText(1000),
})
export type AvailablePatch = z.output<typeof availableSchema>

const installedSchema = z.object({
  external_id: externalId(),
  kb: optText(50),
  title: optText(500),
  installed_on: dateish(),
})
export type InstalledPatch = z.output<typeof installedSchema>

export const patchScanSchema = z.object({
  source: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(SCAN_SOURCES)),
  scanned_at: z.unknown().optional().transform(parseTimestamp),
  available: listOf(availableSchema, LIMITS.available),
  installed: listOf(installedSchema, LIMITS.installed),
})
export type PatchScanInput = z.output<typeof patchScanSchema>

export const jobUpdateSchema = z.object({
  status: z.enum(["running", "succeeded", "failed"]),
  exit_code: num().transform(toInt32),
  output: z.preprocess((v) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v)), z.string().nullable()),
  result: z.preprocess((v) => (v === undefined ? null : v), z.record(z.string(), z.unknown()).nullable()),
})
export type JobUpdateInput = z.output<typeof jobUpdateSchema>

export type InstallResult = {
  results: { external_id: string; status: "installed" | "failed" | "pending_reboot"; error: string | null }[]
  reboot_required: boolean
}

/** The `result` of an install_patches job, read defensively. */
export function parseInstallResult(result: Record<string, unknown> | null | undefined): InstallResult {
  const out: InstallResult = { results: [], reboot_required: false }
  if (!result) return out
  const r = result.reboot_required
  out.reboot_required = r === true || r === "true" || r === 1
  const seen = new Set<string>()
  for (const item of toList(result.results).slice(0, LIMITS.results)) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    const id = typeof it.external_id === "number" ? String(it.external_id) : typeof it.external_id === "string" ? cleanText(it.external_id, 300) : ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    const raw = typeof it.status === "string" ? it.status.trim().toLowerCase() : ""
    const status = raw === "installed" || raw === "succeeded" || raw === "success" ? "installed" : raw === "pending_reboot" || raw === "reboot_required" ? "pending_reboot" : "failed"
    const error = typeof it.error === "string" && it.error.trim() ? cleanText(it.error, 2000) : status === "failed" && raw !== "failed" ? `Unknown status "${cleanText(raw, 40)}"` : null
    out.results.push({ external_id: id, status, error })
  }
  return out
}

/** Reads a request body as JSON with a byte cap (400 on bad JSON, 413 when too large). */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError(`Request body is larger than ${Math.round(maxBytes / 1024)} KB`, 413, "too_large")
  if (!req.body) throw new AppError("Send a JSON body", 400, "bad_request")
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new AppError(`Request body is larger than ${Math.round(maxBytes / 1024)} KB`, 413, "too_large")
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "")
  if (!text.trim()) throw new AppError("Send a JSON body", 400, "bad_request")
  try {
    return JSON.parse(text)
  } catch {
    throw new AppError("The body is not valid JSON", 400, "bad_request")
  }
}
