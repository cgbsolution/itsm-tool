/**
 * Class attribute schemas: validating a schema (class editor) and coercing
 * attribute values against it (CI form, import, agent). Pure.
 */
import type { CiAttribute } from "@/lib/cmdb/classes"
import { cleanText, parseBoolInput, parseDateInput, parseNumberInput } from "@/lib/cmdb/values"

export const ATTR_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/
export const ATTR_TYPES = ["text", "number", "date", "select", "boolean"] as const
export type AttrType = (typeof ATTR_TYPES)[number]
export const MAX_ATTRIBUTES = 100

/** Keys that are CI columns, so they cannot also be attributes. */
export const RESERVED_ATTRIBUTE_KEYS = new Set([
  "id", "ci_code", "code", "name", "class", "status", "condition", "environment", "criticality", "owner", "owner_email",
  "support_group", "organization", "location", "room", "department", "manufacturer", "model", "serial_no",
  "purchase_date", "warranty_years", "warranty_expiry", "cost", "notes", "source", "last_seen_at", "created_at", "updated_at",
])

/** The schema stored in ci_classes.attributes, read defensively. */
export function readSchema(raw: unknown): CiAttribute[] {
  if (!Array.isArray(raw)) return []
  const out: CiAttribute[] = []
  for (const a of raw) {
    if (!a || typeof a !== "object") continue
    const r = a as Record<string, unknown>
    if (typeof r.key !== "string" || !ATTR_KEY_RE.test(r.key)) continue
    const type = (ATTR_TYPES as readonly string[]).includes(String(r.type)) ? (r.type as AttrType) : "text"
    out.push({
      key: r.key,
      label: typeof r.label === "string" && r.label.trim() ? r.label : r.key,
      type,
      ...(type === "select" ? { options: Array.isArray(r.options) ? r.options.map(String) : [] } : {}),
      ...(r.required ? { required: true } : {}),
    })
  }
  return out
}

export type SchemaRowInput = { key?: unknown; label?: unknown; type?: unknown; options?: unknown; required?: unknown }

/** Validates the class editor's rows. Blank rows are ignored. Throws Error with a readable message. */
export function parseAttributeSchema(rows: SchemaRowInput[]): CiAttribute[] {
  const out: CiAttribute[] = []
  const seen = new Set<string>()
  rows.forEach((r, i) => {
    const key = String(r.key ?? "").trim()
    const label = cleanText(r.label, 100)
    if (!key && !label) return
    const n = `Attribute ${i + 1}`
    if (!ATTR_KEY_RE.test(key)) throw new Error(`${n}: the key "${key.slice(0, 50)}" must start with a lower-case letter and use only a-z, 0-9 and _ (up to 41 characters)`)
    if (RESERVED_ATTRIBUTE_KEYS.has(key)) throw new Error(`${n}: "${key}" is a built-in field; choose another key`)
    if (seen.has(key)) throw new Error(`${n}: the key "${key}" is used twice`)
    seen.add(key)
    const type = String(r.type ?? "text")
    if (!(ATTR_TYPES as readonly string[]).includes(type)) throw new Error(`${n}: unknown type "${type.slice(0, 20)}"`)
    const attr: CiAttribute = { key, label: label ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), type: type as AttrType }
    if (type === "select") {
      const options = [
        ...new Set(
          String(r.options ?? "")
            .split(/[,\n]/)
            .map((o) => o.trim())
            .filter(Boolean)
        ),
      ]
      if (!options.length) throw new Error(`${n} (${key}): a select needs at least one option`)
      if (options.length > 100) throw new Error(`${n} (${key}): at most 100 options`)
      if (options.some((o) => o.length > 100)) throw new Error(`${n} (${key}): options must be under 100 characters`)
      attr.options = options
    }
    const req = r.required
    if (req === true || req === "on" || req === "true" || req === "1") attr.required = true
    out.push(attr)
  })
  if (out.length > MAX_ATTRIBUTES) throw new Error(`A class can have at most ${MAX_ATTRIBUTES} attributes`)
  return out
}

/** One value against its definition. Empty input gives undefined (no value). */
export function coerceAttribute(attr: CiAttribute, raw: unknown): unknown {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return undefined
  switch (attr.type) {
    case "number":
      return parseNumberInput(raw) ?? undefined
    case "date":
      return parseDateInput(raw) ?? undefined
    case "boolean":
      return parseBoolInput(raw) ?? undefined
    case "select": {
      const v = String(raw).trim()
      const match = (attr.options ?? []).find((o) => o.toLowerCase() === v.toLowerCase())
      if (!match) throw new Error(`"${v.slice(0, 40)}" is not one of: ${(attr.options ?? []).join(", ")}`)
      return match
    }
    default:
      return cleanText(raw, 2000) ?? undefined
  }
}

export type AttributeResult = { attributes: Record<string, unknown>; errors: string[] }

/**
 * Applies submitted values to existing attributes.
 * - "form": every schema key is taken from `raw` (missing/empty clears it);
 *   keys outside the schema are kept as they are.
 * - "merge" (import, agent): only non-empty values in `raw` are applied; keys
 *   outside the schema are stored as text.
 * Required schema attributes must have a value afterwards.
 */
export function applyAttributes(schema: CiAttribute[], existing: Record<string, unknown> | null | undefined, raw: Record<string, unknown>, mode: "form" | "merge"): AttributeResult {
  const attributes: Record<string, unknown> = { ...(existing ?? {}) }
  const errors: string[] = []
  const byKey = new Map(schema.map((a) => [a.key, a]))
  for (const a of schema) {
    if (mode === "merge" && !(a.key in raw)) continue
    try {
      const v = coerceAttribute(a, raw[a.key])
      if (v === undefined) {
        if (mode === "form") delete attributes[a.key]
      } else attributes[a.key] = v
    } catch (e) {
      errors.push(`${a.label}: ${(e as Error).message}`)
    }
  }
  if (mode === "merge") {
    for (const [k, v] of Object.entries(raw)) {
      if (byKey.has(k) || !ATTR_KEY_RE.test(k)) continue
      const t = cleanText(v, 2000)
      if (t !== null) attributes[k] = t
    }
  }
  for (const a of schema) {
    if (a.required && (attributes[a.key] === undefined || attributes[a.key] === null || attributes[a.key] === "")) errors.push(`${a.label} is required`)
  }
  return { attributes, errors }
}

/** Display form of an attribute value. */
export function formatAttribute(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—"
  if (v === true) return "Yes"
  if (v === false) return "No"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}
