/**
 * Custom ticket fields. Values are stored in tickets.custom under the field's
 * key, so the key never changes once created. Requires admin.itsm.
 */
import { q, q1, exec, tx, isUuid, isUniqueViolation, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { bool } from "@/lib/validate"
import type { CustomFieldRow } from "@/lib/itsm/config"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { fieldKeyProblem, optionalText, parseOptions, parseTicketTypes, requiredText, wholeNumber } from "@/lib/admin/rules"

export const FIELD_TYPES = ["text", "textarea", "number", "date", "select", "multiselect", "checkbox", "email"] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  number: "Number",
  date: "Date",
  select: "Pick one",
  multiselect: "Pick several",
  checkbox: "Yes / no",
  email: "Email address",
}

const SELECT = "select id, key, label, field_type, options, required, ticket_types, help_text, sort_order, is_active from custom_fields"

export async function listCustomFieldsAdmin(actor: Actor): Promise<CustomFieldRow[]> {
  assertPermission(actor, "admin.itsm")
  return q<CustomFieldRow>(`${SELECT} where tenant_id = $1 order by is_active desc, sort_order, lower(label)`, [actor.tenantId])
}

export async function getCustomField(actor: Actor, id: string): Promise<CustomFieldRow> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Field not found")
  const f = await q1<CustomFieldRow>(`${SELECT} where tenant_id = $1 and id = $2`, [actor.tenantId, id])
  if (!f) throw notFound("Field not found")
  return f
}

export type FieldInput = {
  key?: unknown
  label: unknown
  fieldType: unknown
  options?: unknown
  required?: unknown
  ticketTypes?: unknown
  helpText?: unknown
  sortOrder?: unknown
  isActive?: unknown
}

async function parseField(db: Db, tenantId: string, input: FieldInput, isNew: boolean) {
  const type = String(input.fieldType ?? "")
  if (!(FIELD_TYPES as readonly string[]).includes(type)) throw new AppError("Choose a field type")
  const options = type === "select" || type === "multiselect" ? parseOptions(input.options) : []
  if ((type === "select" || type === "multiselect") && options.length === 0) throw new AppError("List at least one option, one per line")
  const sortRaw = String(input.sortOrder ?? "").trim()
  const sortOrder = sortRaw
    ? wholeNumber(sortRaw, "Order", -100000, 100000)
    : isNew
      ? ((await q1<{ n: number }>("select coalesce(max(sort_order), 0) + 1 as n from custom_fields where tenant_id = $1", [tenantId], db))?.n ?? 1)
      : 0
  return {
    label: requiredText(input.label, 100, "Label"),
    field_type: type as FieldType,
    options,
    required: bool(input.required),
    ticket_types: parseTicketTypes(input.ticketTypes),
    help_text: optionalText(input.helpText, 500, "Help text"),
    sort_order: sortOrder,
    is_active: input.isActive === undefined ? true : bool(input.isActive),
  }
}

export async function createCustomField(actor: Actor, input: FieldInput): Promise<string> {
  assertPermission(actor, "admin.itsm")
  const key = String(input.key ?? "").trim()
  const problem = fieldKeyProblem(key)
  if (problem) throw new AppError(problem)
  try {
    return await tx(async (db) => {
      const f = await parseField(db, actor.tenantId, input, true)
      const row = await q1<{ id: string }>(
        `insert into custom_fields (tenant_id, key, label, field_type, options, required, ticket_types, help_text, sort_order, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [actor.tenantId, key, f.label, f.field_type, f.options, f.required, f.ticket_types, f.help_text, f.sort_order, f.is_active],
        db
      )
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.custom_field_created", entityType: "custom_field", entityId: row!.id, summary: `Custom field ${f.label} (${key}) created`, data: { key, ...f } },
        db
      )
      return row!.id
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("A field with that key already exists")
    throw e
  }
}

/** Everything except the key. */
export async function updateCustomField(actor: Actor, id: string, input: FieldInput): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Field not found")
  await tx(async (db) => {
    const before = await q1<CustomFieldRow>(`${SELECT} where tenant_id = $1 and id = $2 for update`, [actor.tenantId, id], db)
    if (!before) throw notFound("Field not found")
    const f = await parseField(db, actor.tenantId, { ...input, sortOrder: String(input.sortOrder ?? "").trim() || before.sort_order }, false)
    const changed = (Object.keys(f) as (keyof typeof f)[]).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(f[k] ?? null))
    if (!changed.length) return
    await exec(
      `update custom_fields set label = $3, field_type = $4, options = $5, required = $6, ticket_types = $7, help_text = $8, sort_order = $9, is_active = $10
        where id = $1 and tenant_id = $2`,
      [id, actor.tenantId, f.label, f.field_type, f.options, f.required, f.ticket_types, f.help_text, f.sort_order, f.is_active],
      db
    )
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.custom_field_updated",
        entityType: "custom_field",
        entityId: id,
        summary: `Custom field ${f.label} (${before.key}) changed: ${changed.join(", ")}`,
        data: { key: before.key, ...Object.fromEntries(changed.map((k) => [k, { from: before[k], to: f[k] }])) },
      },
      db
    )
  })
}

/** Removes the definition. Values already saved on tickets stay in the data but are no longer shown. */
export async function deleteCustomField(actor: Actor, id: string): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Field not found")
  await tx(async (db) => {
    const f = await q1<{ key: string; label: string }>("select key, label from custom_fields where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], db)
    if (!f) throw notFound("Field not found")
    const used = await q1<{ n: number }>("select count(*) as n from tickets where tenant_id = $1 and custom ? $2", [actor.tenantId, f.key], db)
    await exec("delete from custom_fields where id = $1 and tenant_id = $2", [id, actor.tenantId], db)
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.custom_field_deleted", entityType: "custom_field", entityId: id, summary: `Custom field ${f.label} (${f.key}) deleted`, data: { key: f.key, tickets_with_values: used!.n } },
      db
    )
  })
}
