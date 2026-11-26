/**
 * SLA (customer-facing) and OLA (per support group) policies.
 * One policy per kind × record type (or all types) × priority (× group for OLAs),
 * as enforced by the sla_policies_key unique index. Changes apply to clocks
 * started afterwards; running clocks keep their targets. Requires admin.itsm.
 */
import { q, q1, exec, tx, isUuid, isUniqueViolation, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { bool } from "@/lib/validate"
import type { SlaPolicyRow } from "@/lib/itsm/config"
import { PRIORITY_LABELS, TICKET_TYPES, TICKET_TYPE_LABELS, isPriority, type TicketType } from "@/lib/itsm/vocab"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { parseDuration, wholeNumber } from "@/lib/admin/rules"

export type AdminSlaPolicy = SlaPolicyRow & { group_name: string | null; updated_at: Date }

const SELECT = `
  select p.id, p.kind, p.ticket_type, p.priority, p.group_id, g.name as group_name, p.response_minutes, p.resolution_minutes,
         p.business_hours, p.warn_percent, p.is_active, p.updated_at
    from sla_policies p left join groups g on g.id = p.group_id`

const ORDER = `order by p.kind, g.name nulls first, p.ticket_type nulls first,
  case p.priority when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`

export async function listSlaPolicies(actor: Actor): Promise<AdminSlaPolicy[]> {
  assertPermission(actor, "admin.itsm")
  return q<AdminSlaPolicy>(`${SELECT} where p.tenant_id = $1 ${ORDER}`, [actor.tenantId])
}

export async function getSlaPolicy(actor: Actor, id: string): Promise<AdminSlaPolicy> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Policy not found")
  const p = await q1<AdminSlaPolicy>(`${SELECT} where p.tenant_id = $1 and p.id = $2`, [actor.tenantId, id])
  if (!p) throw notFound("Policy not found")
  return p
}

export type SlaInput = {
  kind: unknown
  ticketType?: unknown
  priority: unknown
  groupId?: unknown
  responseHours?: unknown
  responseMinutes?: unknown
  resolutionHours?: unknown
  resolutionMinutes?: unknown
  businessHours?: unknown
  warnPercent?: unknown
  isActive?: unknown
}

async function parseSla(db: Db, tenantId: string, input: SlaInput) {
  const kind = String(input.kind ?? "sla")
  if (kind !== "sla" && kind !== "ola") throw new AppError("Choose SLA or OLA")
  const typeRaw = String(input.ticketType ?? "").trim()
  let ticketType: TicketType | null = null
  if (typeRaw && typeRaw !== "all") {
    if (!(TICKET_TYPES as readonly string[]).includes(typeRaw)) throw new AppError("Unknown record type")
    ticketType = typeRaw as TicketType
  }
  if (!isPriority(input.priority)) throw new AppError("Choose a priority")
  let groupId: string | null = null
  if (kind === "ola") {
    const g = String(input.groupId ?? "").trim()
    if (!g) throw new AppError("An OLA needs a support group")
    if (!isUuid(g) || !(await q1("select 1 from groups where id = $1 and tenant_id = $2", [g, tenantId], db))) throw new AppError("Unknown support group")
    groupId = g
  }
  const response = parseDuration(input.responseHours, input.responseMinutes, "Response target")
  const resolution = parseDuration(input.resolutionHours, input.resolutionMinutes, "Resolution target")
  if (resolution < response) throw new AppError("The resolution target cannot be shorter than the response target")
  return {
    kind: kind as "sla" | "ola",
    ticket_type: ticketType,
    priority: input.priority,
    group_id: groupId,
    response_minutes: response,
    resolution_minutes: resolution,
    business_hours: bool(input.businessHours),
    warn_percent: wholeNumber(input.warnPercent ?? 75, "Warning", 10, 99),
    is_active: input.isActive === undefined ? true : bool(input.isActive),
  }
}

function describe(p: { kind: string; ticket_type: string | null; priority: string }) {
  return `${p.kind.toUpperCase()} ${p.ticket_type ? TICKET_TYPE_LABELS[p.ticket_type as TicketType] : "all types"} ${PRIORITY_LABELS[p.priority as keyof typeof PRIORITY_LABELS] ?? p.priority}`
}

function friendly(e: unknown, kind: string): never {
  if (isUniqueViolation(e, "sla_policies_key")) {
    throw new AppError(
      kind === "ola"
        ? "This group already has an OLA policy for that record type and priority. Edit that one instead."
        : "There is already an SLA policy for that record type and priority. Edit that one instead."
    )
  }
  throw e
}

export async function createSlaPolicy(actor: Actor, input: SlaInput): Promise<string> {
  assertPermission(actor, "admin.itsm")
  try {
    return await tx(async (db) => {
      const p = await parseSla(db, actor.tenantId, input)
      const row = await q1<{ id: string }>(
        `insert into sla_policies (tenant_id, kind, ticket_type, priority, group_id, response_minutes, resolution_minutes, business_hours, warn_percent, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [actor.tenantId, p.kind, p.ticket_type, p.priority, p.group_id, p.response_minutes, p.resolution_minutes, p.business_hours, p.warn_percent, p.is_active],
        db
      )
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.sla_policy_created", entityType: "sla_policy", entityId: row!.id, summary: `${describe(p)} policy created`, data: p },
        db
      )
      return row!.id
    })
  } catch (e) {
    friendly(e, String(input.kind))
  }
}

export async function updateSlaPolicy(actor: Actor, id: string, input: SlaInput): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Policy not found")
  try {
    await tx(async (db) => {
      const before = await q1<SlaPolicyRow>(
        `select id, kind, ticket_type, priority, group_id, response_minutes, resolution_minutes, business_hours, warn_percent, is_active
           from sla_policies where id = $1 and tenant_id = $2 for update`,
        [id, actor.tenantId],
        db
      )
      if (!before) throw notFound("Policy not found")
      const p = await parseSla(db, actor.tenantId, { ...input, kind: before.kind })
      const changed = (Object.keys(p) as (keyof typeof p)[]).filter((k) => (before[k] ?? null) !== (p[k] ?? null))
      if (!changed.length) return
      await exec(
        `update sla_policies set ticket_type = $3, priority = $4, group_id = $5, response_minutes = $6, resolution_minutes = $7,
                business_hours = $8, warn_percent = $9, is_active = $10, updated_at = now()
          where id = $1 and tenant_id = $2`,
        [id, actor.tenantId, p.ticket_type, p.priority, p.group_id, p.response_minutes, p.resolution_minutes, p.business_hours, p.warn_percent, p.is_active],
        db
      )
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: "admin.sla_policy_updated",
          entityType: "sla_policy",
          entityId: id,
          summary: `${describe(p)} policy changed: ${changed.join(", ")}`,
          data: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: p[k] }])),
        },
        db
      )
    })
  } catch (e) {
    friendly(e, String(input.kind))
  }
}

export async function deleteSlaPolicy(actor: Actor, id: string): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Policy not found")
  await tx(async (db) => {
    const p = await q1<SlaPolicyRow>(
      `select id, kind, ticket_type, priority, group_id, response_minutes, resolution_minutes, business_hours, warn_percent, is_active
         from sla_policies where id = $1 and tenant_id = $2 for update`,
      [id, actor.tenantId],
      db
    )
    if (!p) throw notFound("Policy not found")
    await exec("delete from sla_policies where id = $1 and tenant_id = $2", [id, actor.tenantId], db)
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.sla_policy_deleted", entityType: "sla_policy", entityId: id, summary: `${describe(p)} policy deleted`, data: { ...p } },
      db
    )
  })
}
