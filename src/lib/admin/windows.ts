/**
 * Maintenance windows and change freezes (blackouts). Times are entered as
 * wall-clock times in the tenant's time zone. Requires admin.itsm.
 */
import { q, q1, exec, tx, isUuid } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { bool, parseLocalDateTime } from "@/lib/validate"
import { actorId } from "@/lib/auth/system"
import type { WindowRow } from "@/lib/itsm/windows"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { optionalText, requiredText } from "@/lib/admin/rules"

export const WINDOW_KINDS = ["maintenance", "blackout"] as const
export const WINDOW_SCOPES = ["all", "changes", "patches"] as const
export const RECURRENCES = ["none", "daily", "weekly", "monthly"] as const

export const WINDOW_KIND_LABELS = { maintenance: "Maintenance window", blackout: "Change freeze" } as const
export const WINDOW_SCOPE_LABELS = { all: "Changes and patches", changes: "Changes only", patches: "Patch deployments only" } as const
export const RECURRENCE_LABELS = { none: "Once", daily: "Every day", weekly: "Every week", monthly: "Every month" } as const

const SELECT = "select id, name, description, kind, applies_to, starts_at, ends_at, recurrence, recurrence_until, is_active from maintenance_windows"

export async function listWindowsAdmin(actor: Actor): Promise<WindowRow[]> {
  assertPermission(actor, "admin.itsm")
  return q<WindowRow>(`${SELECT} where tenant_id = $1 order by is_active desc, starts_at desc`, [actor.tenantId])
}

export async function getWindow(actor: Actor, id: string): Promise<WindowRow> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Window not found")
  const w = await q1<WindowRow>(`${SELECT} where tenant_id = $1 and id = $2`, [actor.tenantId, id])
  if (!w) throw notFound("Window not found")
  return w
}

export type WindowInput = {
  name: unknown
  description?: unknown
  kind: unknown
  appliesTo: unknown
  startsAt: unknown
  endsAt: unknown
  recurrence: unknown
  recurrenceUntil?: unknown
  isActive?: unknown
}

const MAX_SPAN: Record<string, number> = { daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 28 * 86_400_000 }

/** Validates a window; start / end / until are datetime-local values in `timeZone`. */
export function parseWindow(input: WindowInput, timeZone: string) {
  const kind = String(input.kind ?? "")
  if (!(WINDOW_KINDS as readonly string[]).includes(kind)) throw new AppError("Choose maintenance window or change freeze")
  const appliesTo = String(input.appliesTo ?? "all")
  if (!(WINDOW_SCOPES as readonly string[]).includes(appliesTo)) throw new AppError("Choose what the window applies to")
  const recurrence = String(input.recurrence ?? "none")
  if (!(RECURRENCES as readonly string[]).includes(recurrence)) throw new AppError("Choose how often it repeats")
  const startsAt = parseLocalDateTime(input.startsAt, timeZone)
  const endsAt = parseLocalDateTime(input.endsAt, timeZone)
  if (!startsAt) throw new AppError("Start is required")
  if (!endsAt) throw new AppError("End is required")
  if (endsAt <= startsAt) throw new AppError("The window must end after it starts")
  const span = endsAt.getTime() - startsAt.getTime()
  if (recurrence !== "none" && span > MAX_SPAN[recurrence]) {
    throw new AppError(`A window that repeats ${RECURRENCE_LABELS[recurrence as keyof typeof RECURRENCE_LABELS].toLowerCase()} cannot last longer than its period`)
  }
  if (recurrence === "none" && span > 366 * 86_400_000) throw new AppError("A window can last at most a year")
  const until = recurrence === "none" ? null : parseLocalDateTime(input.recurrenceUntil, timeZone)
  if (until && until <= startsAt) throw new AppError("“Repeat until” must be after the first start")
  return {
    name: requiredText(input.name, 200, "Name"),
    description: optionalText(input.description, 2000, "Description"),
    kind: kind as WindowRow["kind"],
    applies_to: appliesTo as WindowRow["applies_to"],
    starts_at: startsAt,
    ends_at: endsAt,
    recurrence: recurrence as WindowRow["recurrence"],
    recurrence_until: until,
    is_active: input.isActive === undefined ? true : bool(input.isActive),
  }
}

function auditData(w: ReturnType<typeof parseWindow>) {
  return { ...w, starts_at: w.starts_at.toISOString(), ends_at: w.ends_at.toISOString(), recurrence_until: w.recurrence_until?.toISOString() ?? null }
}

export async function createWindow(actor: Actor, input: WindowInput): Promise<string> {
  assertPermission(actor, "admin.itsm")
  const w = parseWindow(input, actor.tenant.timezone)
  return tx(async (db) => {
    const row = await q1<{ id: string }>(
      `insert into maintenance_windows (tenant_id, name, description, kind, applies_to, starts_at, ends_at, recurrence, recurrence_until, is_active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [actor.tenantId, w.name, w.description, w.kind, w.applies_to, w.starts_at, w.ends_at, w.recurrence, w.recurrence_until, w.is_active, actorId(actor)],
      db
    )
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: w.kind === "blackout" ? "admin.change_freeze_created" : "admin.maintenance_window_created",
        entityType: "maintenance_window",
        entityId: row!.id,
        summary: `${WINDOW_KIND_LABELS[w.kind]} ${w.name} created`,
        data: auditData(w),
      },
      db
    )
    return row!.id
  })
}

export async function updateWindow(actor: Actor, id: string, input: WindowInput): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Window not found")
  const w = parseWindow(input, actor.tenant.timezone)
  await tx(async (db) => {
    const before = await q1<WindowRow>(`${SELECT} where tenant_id = $1 and id = $2 for update`, [actor.tenantId, id], db)
    if (!before) throw notFound("Window not found")
    const norm = (v: unknown) => (v instanceof Date ? v.getTime() : (v ?? null))
    const changed = (Object.keys(w) as (keyof typeof w)[]).filter((k) => norm(before[k]) !== norm(w[k]))
    if (!changed.length) return
    await exec(
      `update maintenance_windows set name = $3, description = $4, kind = $5, applies_to = $6, starts_at = $7, ends_at = $8,
              recurrence = $9, recurrence_until = $10, is_active = $11
        where id = $1 and tenant_id = $2`,
      [id, actor.tenantId, w.name, w.description, w.kind, w.applies_to, w.starts_at, w.ends_at, w.recurrence, w.recurrence_until, w.is_active],
      db
    )
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: w.kind === "blackout" ? "admin.change_freeze_updated" : "admin.maintenance_window_updated",
        entityType: "maintenance_window",
        entityId: id,
        summary: `${WINDOW_KIND_LABELS[w.kind]} ${w.name} changed: ${changed.join(", ")}`,
        data: { fields: changed, after: auditData(w) },
      },
      db
    )
  })
}

export async function deleteWindow(actor: Actor, id: string): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Window not found")
  await tx(async (db) => {
    const w = await q1<{ name: string; kind: WindowRow["kind"] }>("select name, kind from maintenance_windows where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], db)
    if (!w) throw notFound("Window not found")
    await exec("delete from maintenance_windows where id = $1 and tenant_id = $2", [id, actor.tenantId], db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: w.kind === "blackout" ? "admin.change_freeze_deleted" : "admin.maintenance_window_deleted",
        entityType: "maintenance_window",
        entityId: id,
        summary: `${WINDOW_KIND_LABELS[w.kind]} ${w.name} deleted`,
        data: { name: w.name, kind: w.kind },
      },
      db
    )
  })
}
