/**
 * Catalog request forms: the field definitions stored in catalog_items.form_fields,
 * the admin form-builder validation, and the server-side validation of the values a
 * requester submits. Pure functions (no database), unit-tested in tests/unit/catalog-forms.test.ts.
 */
import { AppError } from "@/lib/errors"

export const FIELD_TYPES = ["text", "textarea", "number", "date", "select", "multiselect", "checkbox", "email"] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  number: "Number",
  date: "Date",
  select: "Choice (one)",
  multiselect: "Choice (several)",
  checkbox: "Checkbox",
  email: "Email address",
}

export type FormField = {
  key: string
  label: string
  type: FieldType
  required: boolean
  options: string[]
  help: string | null
}

export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/
export const MAX_FIELDS = 50
const MAX_OPTIONS = 100
const TEXT_MAX = 500
const TEXTAREA_MAX = 10_000
const EMAIL_MAX = 320

export function isFieldType(v: unknown): v is FieldType {
  return typeof v === "string" && (FIELD_TYPES as readonly string[]).includes(v)
}

const withOptions = (t: FieldType) => t === "select" || t === "multiselect"

/** Field definitions from stored JSON. Lenient: drops entries that are not usable. */
export function normalizeFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: FormField[] = []
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const key = typeof o.key === "string" ? o.key : ""
    if (!FIELD_KEY_RE.test(key) || seen.has(key)) continue
    const type = isFieldType(o.type) ? o.type : "text"
    const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []
    if (withOptions(type) && options.length === 0) continue
    seen.add(key)
    out.push({
      key,
      label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : key,
      type,
      required: o.required === true,
      options: withOptions(type) ? [...new Set(options)] : [],
      help: typeof o.help === "string" && o.help.trim() ? o.help.trim() : null,
    })
  }
  return out
}

/* ── form builder (admin) ──────────────────────────────────────────────── */

export type FieldRowInput = {
  sort?: number | string | null
  key?: string | null
  label?: string | null
  type?: string | null
  options?: string | null
  required?: boolean
  help?: string | null
  remove?: boolean
}

/** "one option per line" → options. */
export function parseOptions(text: string | null | undefined): string[] {
  return [
    ...new Set(
      String(text ?? "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ]
}

/**
 * Builds field definitions from the builder rows: drops removed and empty rows,
 * orders by the sort field (then row order), and validates keys, labels, types and options.
 * Throws an AppError naming the row on the first problem.
 */
export function buildFormFields(rows: FieldRowInput[]): FormField[] {
  const kept = rows
    .map((r, i) => ({ r, i, sort: Number.isFinite(Number(r.sort)) && String(r.sort ?? "").trim() !== "" ? Number(r.sort) : (i + 1) * 10 }))
    .filter(({ r }) => !r.remove && (String(r.key ?? "").trim() !== "" || String(r.label ?? "").trim() !== ""))
    .sort((a, b) => a.sort - b.sort || a.i - b.i)
  if (kept.length > MAX_FIELDS) throw new AppError(`A form can have at most ${MAX_FIELDS} fields`)
  const seen = new Set<string>()
  return kept.map(({ r, i }) => {
    const key = String(r.key ?? "").trim()
    const label = String(r.label ?? "").trim()
    const where = `Row ${i + 1}${label ? ` (${label})` : ""}`
    if (!key) throw new AppError(`${where}: give the field a key`)
    if (!FIELD_KEY_RE.test(key)) {
      throw new AppError(`${where}: the key "${key.slice(0, 50)}" must start with a lower-case letter and use only a-z, 0-9 and _ (max 41 characters)`)
    }
    if (seen.has(key)) throw new AppError(`${where}: the key "${key}" is used twice`)
    seen.add(key)
    if (!label) throw new AppError(`${where}: give the field a label`)
    if (label.length > 200) throw new AppError(`${where}: keep the label under 200 characters`)
    if (!isFieldType(r.type)) throw new AppError(`${where}: choose a field type`)
    const options = withOptions(r.type) ? parseOptions(r.options) : []
    if (withOptions(r.type)) {
      if (options.length === 0) throw new AppError(`${where}: list the options, one per line`)
      if (options.length > MAX_OPTIONS) throw new AppError(`${where}: at most ${MAX_OPTIONS} options`)
      const long = options.find((o) => o.length > 200)
      if (long) throw new AppError(`${where}: the option "${long.slice(0, 40)}…" is longer than 200 characters`)
    }
    const help = String(r.help ?? "").trim()
    if (help.length > 500) throw new AppError(`${where}: keep the help text under 500 characters`)
    return { key, label, type: r.type, required: !!r.required, options, help: help || null }
  })
}

/* ── request values (requester) ────────────────────────────────────────── */

export type RawValue = string | number | boolean | null | undefined | (string | number)[]
export type FormValues = Record<string, string | number | boolean | string[]>
export type ValidationResult = { ok: true; values: FormValues } | { ok: false; errors: Record<string, string> }

const first = (v: RawValue): unknown => (Array.isArray(v) ? v[0] : v)
const NUMBER_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s.]{1,63}(?:\.[^@\s.]{1,63})+$/

export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 1900 || y > 2200) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function truthy(v: unknown): boolean {
  return v === true || (typeof v === "string" && ["on", "true", "1", "yes"].includes(v.trim().toLowerCase())) || v === 1
}

/**
 * Validates submitted values against the form definition. Unknown keys are ignored;
 * empty optional fields are left out; checkboxes are always true/false. Returns
 * coerced values (numbers as numbers, multiselect as string arrays), or one
 * readable message per field.
 */
export function validateFormValues(fields: FormField[], raw: Record<string, RawValue>): ValidationResult {
  const values: FormValues = {}
  const errors: Record<string, string> = {}
  for (const f of fields) {
    const v = raw[f.key]
    if (f.type === "checkbox") {
      const checked = truthy(first(v))
      if (f.required && !checked) errors[f.key] = `${f.label} must be ticked`
      values[f.key] = checked
      continue
    }
    if (f.type === "multiselect") {
      const list = (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map((x) => String(x).trim()).filter(Boolean)
      const picked = [...new Set(list)]
      if (picked.length === 0) {
        if (f.required) errors[f.key] = `${f.label}: choose at least one option`
        continue
      }
      const bad = picked.find((p) => !f.options.includes(p))
      if (bad) errors[f.key] = `${f.label}: "${bad.slice(0, 60)}" is not one of the options`
      else values[f.key] = f.options.filter((o) => picked.includes(o))
      continue
    }
    const one = first(v)
    const s = one === undefined || one === null ? "" : typeof one === "number" ? String(one) : String(one).trim()
    if (s === "") {
      if (f.required) errors[f.key] = f.type === "select" ? `${f.label}: choose an option` : `${f.label} is required`
      continue
    }
    switch (f.type) {
      case "number": {
        const n = typeof one === "number" ? one : NUMBER_RE.test(s) ? Number(s) : NaN
        if (!Number.isFinite(n) || Math.abs(n) > 1e12) errors[f.key] = `${f.label} must be a number`
        else values[f.key] = n
        break
      }
      case "date":
        if (!isValidDate(s)) errors[f.key] = `${f.label} must be a valid date (YYYY-MM-DD)`
        else values[f.key] = s
        break
      case "email":
        if (s.length > EMAIL_MAX || !EMAIL_RE.test(s)) errors[f.key] = `${f.label} must be a valid email address`
        else values[f.key] = s
        break
      case "select":
        if (!f.options.includes(s)) errors[f.key] = `${f.label}: "${s.slice(0, 60)}" is not one of the options`
        else values[f.key] = s
        break
      case "textarea":
        if (s.length > TEXTAREA_MAX) errors[f.key] = `${f.label} is too long (at most ${TEXTAREA_MAX.toLocaleString("en")} characters)`
        else values[f.key] = s
        break
      default:
        if (s.length > TEXT_MAX) errors[f.key] = `${f.label} is too long (at most ${TEXT_MAX} characters)`
        else values[f.key] = s.replace(/\s+/g, " ")
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values }
}

/** One message for all field errors, in form order. */
export function formatErrors(fields: FormField[], errors: Record<string, string>): string {
  const list = fields.filter((f) => errors[f.key]).map((f) => errors[f.key])
  if (list.length === 1) return list[0]
  return `Please check ${list.length} fields: ${list.join("; ")}`
}

/** Validates or throws an AppError with readable messages. */
export function requireValidValues(fields: FormField[], raw: Record<string, RawValue>): FormValues {
  const r = validateFormValues(fields, raw)
  if (!r.ok) throw new AppError(formatErrors(fields, r.errors))
  return r.values
}

/* ── request text ──────────────────────────────────────────────────────── */

function display(f: FormField, v: FormValues[string]): string {
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (Array.isArray(v)) return v.join(", ")
  return String(v)
}

/** Ticket subject: the item name, plus the first short-text answer when there is one. */
export function requestSubject(itemName: string, fields: FormField[], values: FormValues): string {
  let s = itemName.trim().replace(/\s+/g, " ")
  const f = fields.find((x) => x.type === "text" && typeof values[x.key] === "string" && (values[x.key] as string).trim())
  if (f) {
    const v = (values[f.key] as string).trim()
    s += " – " + (v.length > 80 ? v.slice(0, 79).trimEnd() + "…" : v)
  }
  if (s.length < 3) s = `Request: ${s}`
  return s.length > 300 ? s.slice(0, 299) + "…" : s
}

/** Readable summary of the answers for the ticket description. */
export function describeAnswers(itemName: string, fields: FormField[], values: FormValues): string {
  const lines = [`Requested through the service catalog: ${itemName.trim()}`, ""]
  for (const f of fields) {
    if (!(f.key in values)) continue
    const v = values[f.key]
    if (f.type === "textarea") {
      lines.push(`${f.label}:`, ...String(v).split(/\r?\n/).map((l) => `  ${l}`))
    } else {
      lines.push(`${f.label}: ${display(f, v)}`)
    }
  }
  if (lines.length === 2) lines.push("(No details were asked for.)")
  return lines.join("\n")
}

/* ── task templates ────────────────────────────────────────────────────── */

export type TaskTemplate = { title: string }

export function normalizeTasks(raw: unknown): TaskTemplate[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((r) => (r && typeof r === "object" && typeof (r as { title?: unknown }).title === "string" ? (r as { title: string }).title.trim() : ""))
    .filter(Boolean)
    .map((title) => ({ title: title.slice(0, 300) }))
}

/** "one task per line" → templates. */
export function parseTaskTemplates(text: string | null | undefined): TaskTemplate[] {
  const titles = String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)
  if (titles.length > 50) throw new AppError("At most 50 tasks per item")
  const long = titles.find((t) => t.length > 300)
  if (long) throw new AppError(`The task "${long.slice(0, 40)}…" is longer than 300 characters`)
  return titles.map((title) => ({ title }))
}
