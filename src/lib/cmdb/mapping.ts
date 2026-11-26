/**
 * CSV import: header → field mapping and per-row normalisation. Pure; the
 * import service (import.ts) supplies the tenant's classes and users.
 */
import { classKeyForLegacyType, type CiAttribute } from "@/lib/cmdb/classes"
import { ATTR_KEY_RE, applyAttributes } from "@/lib/cmdb/attributes"
import { CI_CONDITIONS, CI_CRITICALITIES, CI_ENVIRONMENTS, type CiStatus } from "@/lib/cmdb/vocab"
import { addYears, cleanText, parseDateInput, parseIntInput, parseNumberInput } from "@/lib/cmdb/values"

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const IMPORT_MAX_ROWS = 10_000

export const IMPORT_FIELDS = [
  "ci_code", "name", "class", "status", "condition", "environment", "criticality", "owner_email",
  "serial_no", "model", "manufacturer", "location", "room", "department",
  "purchase_date", "warranty_years", "warranty_expiry", "cost", "notes",
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

/** Normalised header → field. */
export const FIELD_ALIASES: Record<string, ImportField> = {
  ci_code: "ci_code", asset_code: "ci_code", code: "ci_code", asset_tag: "ci_code", asset_id: "ci_code", ci: "ci_code",
  name: "name", ci_name: "name", asset_name: "name",
  class: "class", asset_type: "class", type: "class", ci_class: "class", category: "class",
  status: "status", asset_status: "status",
  condition: "condition",
  environment: "environment",
  criticality: "criticality",
  owner_email: "owner_email", assigned_to_email: "owner_email", user_email: "owner_email",
  serial_no: "serial_no", serial: "serial_no", serial_number: "serial_no", serialno: "serial_no",
  model: "model",
  manufacturer: "manufacturer", vendor: "manufacturer", make: "manufacturer", brand: "manufacturer",
  location: "location", site: "location",
  room: "room",
  department: "department", dept: "department",
  purchase_date: "purchase_date", purchased: "purchase_date", purchased_on: "purchase_date",
  warranty_years: "warranty_years", warranty_period_years: "warranty_years",
  warranty_expiry: "warranty_expiry", warranty_expiry_date: "warranty_expiry", warranty_end: "warranty_expiry", warranty_end_date: "warranty_expiry",
  cost: "cost", price: "cost", purchase_cost: "cost",
  notes: "notes", remarks: "notes", comments: "notes",
}

/** Columns of our own CSV export that are not imported. */
const IGNORED_HEADERS = new Set(["id", "owner_name", "class_name", "support_group", "organization", "source", "last_seen_at", "created_at", "updated_at"])

export type ColumnTarget = { kind: "field"; field: ImportField } | { kind: "attribute"; key: string } | { kind: "ignored"; reason: string }
export type ColumnMap = { index: number; header: string; target: ColumnTarget }

export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/** Maps each header. A field's first column wins; a later duplicate becomes an attribute. */
export function mapColumns(headers: string[]): ColumnMap[] {
  const used = new Set<ImportField>()
  const usedAttrs = new Set<string>()
  return headers.map((header, index) => {
    const norm = normalizeHeader(header)
    let target: ColumnTarget
    const field = FIELD_ALIASES[norm]
    if (!norm) target = { kind: "ignored", reason: "no header" }
    else if (field && !used.has(field)) {
      used.add(field)
      target = { kind: "field", field }
    } else if (IGNORED_HEADERS.has(norm)) target = { kind: "ignored", reason: "not imported" }
    else {
      const key = norm.startsWith("attributes_") ? norm.slice("attributes_".length) : norm
      if (!ATTR_KEY_RE.test(key)) target = { kind: "ignored", reason: "not a valid attribute name" }
      else if (usedAttrs.has(key)) target = { kind: "ignored", reason: "duplicate column" }
      else {
        usedAttrs.add(key)
        target = { kind: "attribute", key }
      }
    }
    return { index, header, target }
  })
}

export function hasCodeColumn(columns: ColumnMap[]): boolean {
  return columns.some((c) => c.target.kind === "field" && c.target.field === "ci_code")
}

const STATUS_WORDS: Record<string, CiStatus> = {
  planned: "planned", ordered: "planned", on_order: "planned", pending: "planned",
  in_stock: "in_stock", spare: "in_stock", stock: "in_stock", instock: "in_stock", available: "in_stock", unassigned: "in_stock", store: "in_stock", in_store: "in_stock",
  in_use: "in_use", inuse: "in_use", active: "in_use", deployed: "in_use", assigned: "in_use", allocated: "in_use", issued: "in_use", live: "in_use", production: "in_use",
  maintenance: "maintenance", in_maintenance: "maintenance", repair: "maintenance", in_repair: "maintenance", under_repair: "maintenance", faulty: "maintenance", broken: "maintenance",
  retired: "retired", inactive: "retired", decommissioned: "retired", obsolete: "retired",
  disposed: "disposed", scrapped: "disposed", sold: "disposed", lost: "disposed", stolen: "disposed", written_off: "disposed", e_waste: "disposed",
}

export function mapStatus(raw: string): CiStatus {
  const s = STATUS_WORDS[normalizeHeader(raw)]
  if (!s) throw new Error(`unknown status "${raw.slice(0, 40)}"`)
  return s
}

const CONDITION_WORDS: Record<string, string> = {
  new: "new", brand_new: "new", excellent: "good", good: "good", ok: "good", working: "good", fair: "fair", average: "fair", used: "fair",
  poor: "poor", bad: "poor", damaged: "damaged", broken: "damaged", faulty: "damaged",
}

export function mapCondition(raw: string): string {
  const c = CONDITION_WORDS[normalizeHeader(raw)]
  if (!c) throw new Error(`unknown condition "${raw.slice(0, 40)}" (use ${CI_CONDITIONS.join(", ")})`)
  return c
}

function oneOf(raw: string, allowed: readonly string[], label: string): string {
  const v = normalizeHeader(raw)
  const hit = allowed.find((a) => a === v || (v.length >= 3 && a.startsWith(v)))
  if (!hit) throw new Error(`unknown ${label} "${raw.slice(0, 40)}" (use ${allowed.join(", ")})`)
  return hit
}

export type ImportClass = { id: string; key: string; name: string; is_active: boolean; attributes: CiAttribute[] }

/** Exact class key, then class name, then the legacy free-text mapping. */
export function resolveClass(raw: string, classes: ImportClass[]): { cls: ImportClass | null; warning?: string } {
  const v = raw.trim()
  const lower = v.toLowerCase()
  const exact = classes.find((c) => c.key === lower || c.key === normalizeHeader(v)) ?? classes.find((c) => c.name.toLowerCase() === lower)
  if (exact) return { cls: exact }
  const key = classKeyForLegacyType(v)
  const cls = classes.find((c) => c.key === key) ?? null
  if (!cls) return { cls: null }
  return key === "other" ? { cls, warning: `class "${v.slice(0, 40)}" not recognised; using ${cls.name}` } : { cls }
}

/** Values of one row, ready to write. Only non-empty cells are present. */
export type RowValues = {
  ci_code: string
  name?: string
  status?: CiStatus
  condition?: string
  environment?: string
  criticality?: string
  owner_email?: string
  serial_no?: string
  model?: string
  manufacturer?: string
  location?: string
  room?: string
  department?: string
  purchase_date?: string
  warranty_years?: number
  warranty_expiry?: string
  cost?: number
  notes?: string
}

export type NormalizedRow = {
  line: number
  values: RowValues | null
  classText: string | null
  /** Raw attribute cells (key → text), applied against the class schema later */
  rawAttributes: Record<string, string>
  errors: string[]
  warnings: string[]
}

const TEXT_LIMITS: Partial<Record<ImportField, number>> = { name: 200, serial_no: 120, model: 200, manufacturer: 200, location: 200, room: 100, department: 200, notes: 10_000, owner_email: 320 }

/** Reads one record against the column map. Does not touch the database. */
export function normalizeRow(cells: string[], columns: ColumnMap[], line: number): NormalizedRow {
  const errors: string[] = []
  const warnings: string[] = []
  const raw: Partial<Record<ImportField, string>> = {}
  const rawAttributes: Record<string, string> = {}
  for (const col of columns) {
    const cell = (cells[col.index] ?? "").trim()
    if (!cell) continue
    if (col.target.kind === "field") raw[col.target.field] = cell
    else if (col.target.kind === "attribute") rawAttributes[col.target.key] = cell.slice(0, 2000)
  }
  if (cells.length > columns.length && cells.slice(columns.length).some((c) => c.trim())) warnings.push("has more values than there are columns; the extra values were ignored")

  const code = cleanText(raw.ci_code, 200)
  if (!code) errors.push("CI code is empty")
  else if (code.length > 64) errors.push("CI code is longer than 64 characters")

  const values: RowValues = { ci_code: code ?? "" }
  const attempt = (label: string, fn: () => void) => {
    try {
      fn()
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`)
    }
  }
  for (const f of ["name", "serial_no", "model", "manufacturer", "location", "room", "department", "notes"] as const) {
    const t = cleanText(raw[f], TEXT_LIMITS[f] ?? 200)
    if (t) values[f] = t
  }
  if (raw.owner_email) {
    const e = raw.owner_email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+$/.test(e)) errors.push(`Owner email: "${raw.owner_email.slice(0, 60)}" is not an email address`)
    else values.owner_email = e.slice(0, 320)
  }
  if (raw.status) attempt("Status", () => (values.status = mapStatus(raw.status!)))
  if (raw.condition) attempt("Condition", () => (values.condition = mapCondition(raw.condition!)))
  if (raw.environment) attempt("Environment", () => (values.environment = oneOf(raw.environment!, CI_ENVIRONMENTS, "environment")))
  if (raw.criticality) attempt("Criticality", () => (values.criticality = oneOf(raw.criticality!, CI_CRITICALITIES, "criticality")))
  if (raw.purchase_date) attempt("Purchase date", () => (values.purchase_date = parseDateInput(raw.purchase_date) ?? undefined))
  if (raw.warranty_expiry) attempt("Warranty expiry", () => (values.warranty_expiry = parseDateInput(raw.warranty_expiry) ?? undefined))
  if (raw.warranty_years) {
    attempt("Warranty years", () => {
      const cleaned = raw.warranty_years!.replace(/\s*(years?|yrs?|y)\s*$/i, "")
      values.warranty_years = parseIntInput(cleaned, 0, 50) ?? undefined
    })
  }
  if (raw.cost) {
    attempt("Cost", () => {
      const n = parseNumberInput(raw.cost!.replace(/^[^\d-]+/, ""))
      if (n !== null && (n < 0 || n > 1e12)) throw new Error("must be between 0 and 1,000,000,000,000")
      values.cost = n ?? undefined
    })
  }
  if (!values.warranty_expiry && values.purchase_date && values.warranty_years !== undefined) {
    values.warranty_expiry = addYears(values.purchase_date, values.warranty_years)
  }
  return { line, values: errors.length ? null : values, classText: raw.class?.trim() || null, rawAttributes, errors, warnings }
}

/** Validates attribute cells against the class schema (merge mode). */
export function rowAttributes(schema: CiAttribute[], existing: Record<string, unknown> | null, rawAttributes: Record<string, string>) {
  return applyAttributes(schema, existing, rawAttributes, "merge")
}
