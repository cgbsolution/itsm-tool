/**
 * Field-level diffs for ci_history: { field: { from, to } }. Pure.
 * Empty strings, undefined and null all count as "no value"; dates compare by
 * instant; objects and arrays compare by their JSON.
 */

export type Change = { from: unknown; to: unknown }
export type Changes = Record<string, Change>

/** Canonical form of a value for comparison and storage. */
export function normalizeValue(v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (typeof v === "string") return v === "" ? null : v
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (Array.isArray(v)) return v.length ? v.map(normalizeValue) : null
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k, normalizeValue(x)] as const)
      .filter(([, x]) => x !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return entries.length ? Object.fromEntries(entries) : null
  }
  return v
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b))
}

/**
 * Differences between two records over `fields` (default: every key of
 * either). `before = null` describes a creation, `after = null` a deletion.
 */
export function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null, fields?: string[]): Changes {
  const b = before ?? {}
  const a = after ?? {}
  const keys = fields ?? [...new Set([...Object.keys(b), ...Object.keys(a)])]
  const out: Changes = {}
  for (const k of keys) {
    if (sameValue(b[k], a[k])) continue
    out[k] = { from: normalizeValue(b[k]), to: normalizeValue(a[k]) }
  }
  return out
}

/** Per-key differences between two attribute objects, keyed `${prefix}${key}`. */
export function diffAttributes(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined, prefix = "attributes."): Changes {
  const inner = diffFields(before ?? {}, after ?? {})
  const out: Changes = {}
  for (const [k, v] of Object.entries(inner)) out[prefix + k] = v
  return out
}

export function hasChanges(c: Changes): boolean {
  return Object.keys(c).length > 0
}
