/**
 * A tenant's ITSM configuration: categories, priority matrix, SLA/OLA
 * policies, working calendar, settings and custom fields.
 * (Legacy loadItsmConfig / checkCategory / resolvePriority, ported.)
 */
import { q, q1, type Db, pool } from "@/lib/db"
import { AppError } from "@/lib/errors"
import type { WorkCalendar } from "@/lib/itsm/clock"
import {
  isLevel,
  isPriority,
  priorityFromMatrix,
  type Level,
  type MatrixCell,
  type Priority,
  type TicketType,
} from "@/lib/itsm/vocab"

export type CategoryRow = {
  id: string
  parent_id: string | null
  name: string
  ticket_types: TicketType[] | null
  sort_order: number
  is_active: boolean
}

export type SlaPolicyRow = {
  id: string
  kind: "sla" | "ola"
  ticket_type: TicketType | null
  priority: Priority
  group_id: string | null
  response_minutes: number
  resolution_minutes: number
  business_hours: boolean
  warn_percent: number
  is_active: boolean
}

export type CustomFieldRow = {
  id: string
  key: string
  label: string
  field_type: "text" | "textarea" | "number" | "date" | "select" | "multiselect" | "checkbox" | "email"
  options: string[]
  required: boolean
  ticket_types: TicketType[] | null
  help_text: string | null
  sort_order: number
  is_active: boolean
}

export type TenantSettings = {
  timezone: string
  work_days: number[]
  work_start: string
  work_end: string
  holidays: string[]
  brand_name: string | null
  brand_color: string
  support_email: string | null
  hold_max_hours: number
  reopen_window_days: number
  auto_close_resolved_days: number
  strict_assignment: boolean
  require_mfa: boolean
  password_min_length: number
  session_hours: number
  inbound_create_users: boolean
}

export type ItsmConfig = {
  categories: CategoryRow[]
  matrix: MatrixCell[]
  policies: SlaPolicyRow[]
  calendar: WorkCalendar
  settings: TenantSettings
  customFields: CustomFieldRow[]
}

const DEFAULT_SETTINGS: TenantSettings = {
  timezone: "UTC",
  work_days: [1, 2, 3, 4, 5],
  work_start: "09:00",
  work_end: "18:00",
  holidays: [],
  brand_name: null,
  brand_color: "#2563eb",
  support_email: null,
  hold_max_hours: 72,
  reopen_window_days: 7,
  auto_close_resolved_days: 3,
  strict_assignment: true,
  require_mfa: false,
  password_min_length: 10,
  session_hours: 12,
  inbound_create_users: false,
}

export async function loadTenantSettings(tenantId: string, db: Db = pool()): Promise<TenantSettings> {
  const row = await q1<TenantSettings & { holidays: string[] | null }>(
    `select timezone, work_days, to_char(work_start, 'HH24:MI') as work_start, to_char(work_end, 'HH24:MI') as work_end,
            coalesce(holidays::text[], '{}') as holidays, brand_name, brand_color, support_email, hold_max_hours,
            reopen_window_days, auto_close_resolved_days, strict_assignment, require_mfa, password_min_length,
            session_hours, inbound_create_users
       from tenant_settings where tenant_id = $1`,
    [tenantId],
    db
  )
  if (!row) return DEFAULT_SETTINGS
  return { ...row, work_days: (row.work_days ?? []).map(Number), holidays: row.holidays ?? [] }
}

export async function loadItsmConfig(tenantId: string, db: Db = pool()): Promise<ItsmConfig> {
  // sequential: `db` may be a single transaction client
  const categories = await q<CategoryRow>(
    "select id, parent_id, name, ticket_types, sort_order, is_active from ticket_categories where tenant_id = $1 order by sort_order, name",
    [tenantId],
    db
  )
  const matrix = await q<MatrixCell>("select impact, urgency, priority from priority_matrix where tenant_id = $1", [tenantId], db)
  const policies = await q<SlaPolicyRow>(
    `select id, kind, ticket_type, priority, group_id, response_minutes, resolution_minutes, business_hours, warn_percent, is_active
       from sla_policies where tenant_id = $1 and is_active`,
    [tenantId],
    db
  )
  const settings = await loadTenantSettings(tenantId, db)
  const customFields = await q<CustomFieldRow>(
    `select id, key, label, field_type, options, required, ticket_types, help_text, sort_order, is_active
       from custom_fields where tenant_id = $1 and is_active order by sort_order, label`,
    [tenantId],
    db
  )
  return {
    categories,
    matrix,
    policies,
    settings,
    customFields,
    calendar: {
      timezone: settings.timezone,
      work_days: settings.work_days,
      work_start: settings.work_start,
      work_end: settings.work_end,
      holidays: settings.holidays,
    },
  }
}

/** SLA (or OLA for a group) policy: one for the type, else the tenant default (no type). */
export function pickPolicy(
  policies: SlaPolicyRow[],
  kind: "sla" | "ola",
  type: TicketType,
  priority: Priority,
  groupId?: string | null
): SlaPolicyRow | null {
  const pool = policies.filter((p) => p.kind === kind && p.is_active && (kind === "sla" || p.group_id === groupId))
  return (
    pool.find((p) => p.ticket_type === type && p.priority === priority) ??
    pool.find((p) => p.ticket_type === null && p.priority === priority) ??
    null
  )
}

/** Validates a category id for a type. Returns the leaf id and the names to store. */
export function resolveCategory(
  config: ItsmConfig,
  type: TicketType,
  categoryId: string | null | undefined
): { category_id: string | null; category: string | null; sub_category: string | null } {
  if (!categoryId) return { category_id: null, category: null, sub_category: null }
  const cat = config.categories.find((c) => c.id === categoryId && c.is_active)
  if (!cat) throw new AppError("That category is not available")
  const offered = (c: CategoryRow) => !c.ticket_types || c.ticket_types.includes(type)
  if (cat.parent_id) {
    const parent = config.categories.find((c) => c.id === cat.parent_id)
    if (!parent || !parent.is_active || !offered(parent)) throw new AppError("That category is not available for this record type")
    return { category_id: cat.id, category: parent.name, sub_category: cat.name }
  }
  if (!offered(cat)) throw new AppError("That category is not available for this record type")
  return { category_id: cat.id, category: cat.name, sub_category: null }
}

/**
 * Priority from impact and urgency (via the matrix). Staff may override it;
 * without impact/urgency a given priority is kept.
 */
export function resolvePriority(
  config: ItsmConfig,
  input: { impact?: unknown; urgency?: unknown; priority?: unknown },
  allowOverride: boolean
): { impact: Level | null; urgency: Level | null; priority: Priority } {
  const impact = isLevel(input.impact) ? input.impact : null
  const urgency = isLevel(input.urgency) ? input.urgency : null
  const given = isPriority(input.priority) ? input.priority : null
  if (impact && urgency) {
    const fromMatrix = priorityFromMatrix(config.matrix, impact, urgency)
    return { impact, urgency, priority: allowOverride && given ? given : fromMatrix }
  }
  return { impact, urgency, priority: given ?? "medium" }
}

/** Validates and coerces custom field values for a type. */
export function resolveCustomFields(
  config: ItsmConfig,
  type: TicketType,
  input: Record<string, unknown> | undefined,
  opts: { partial?: boolean } = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const fields = config.customFields.filter((f) => !f.ticket_types || f.ticket_types.includes(type))
  for (const f of fields) {
    const raw = input?.[f.key]
    if (opts.partial && raw === undefined) continue
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)
    if (empty) {
      if (f.required && f.field_type !== "checkbox") throw new AppError(`${f.label} is required`)
      continue
    }
    switch (f.field_type) {
      case "number": {
        const n = Number(raw)
        if (!Number.isFinite(n)) throw new AppError(`${f.label} must be a number`)
        out[f.key] = n
        break
      }
      case "checkbox":
        out[f.key] = raw === true || raw === "on" || raw === "true" || raw === "1"
        break
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw new AppError(`${f.label} must be a date`)
        out[f.key] = String(raw)
        break
      case "email":
        if (!/^[^@\s]+@[^@\s]+$/.test(String(raw))) throw new AppError(`${f.label} must be an email address`)
        out[f.key] = String(raw).slice(0, 320)
        break
      case "select":
        if (!f.options.includes(String(raw))) throw new AppError(`${f.label}: choose one of the listed options`)
        out[f.key] = String(raw)
        break
      case "multiselect": {
        const values = (Array.isArray(raw) ? raw : [raw]).map(String)
        if (values.some((v) => !f.options.includes(v))) throw new AppError(`${f.label}: choose from the listed options`)
        out[f.key] = values
        break
      }
      default:
        out[f.key] = String(raw).slice(0, f.field_type === "textarea" ? 10_000 : 500)
    }
  }
  return out
}
