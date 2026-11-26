/**
 * ITSM configuration: the category tree, the impact × urgency priority matrix
 * and the working calendar / ticket behaviour in tenant_settings.
 * Requires admin.itsm.
 */
import { q, q1, exec, tx, isUuid, isUniqueViolation } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { bool } from "@/lib/validate"
import { isValidTimeZone } from "@/lib/itsm/clock"
import { loadTenantSettings, type CategoryRow } from "@/lib/itsm/config"
import { LEVELS, isPriority, priorityFromMatrix, type Level, type MatrixCell, type Priority } from "@/lib/itsm/vocab"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { parseHolidays, parseTicketTypes, parseTimeOfDay, parseWorkDays, requiredText, wholeNumber } from "@/lib/admin/rules"

/* ── overview ──────────────────────────────────────────────────────────── */

export async function itsmOverview(actor: Actor) {
  assertPermission(actor, "admin.itsm")
  const counts = await q1<{ categories: number; subs: number; sla: number; ola: number; fields: number; windows: number; freezes: number }>(
    `select (select count(*) from ticket_categories where tenant_id = $1 and parent_id is null and is_active) as categories,
            (select count(*) from ticket_categories where tenant_id = $1 and parent_id is not null and is_active) as subs,
            (select count(*) from sla_policies where tenant_id = $1 and kind = 'sla' and is_active) as sla,
            (select count(*) from sla_policies where tenant_id = $1 and kind = 'ola' and is_active) as ola,
            (select count(*) from custom_fields where tenant_id = $1 and is_active) as fields,
            (select count(*) from maintenance_windows where tenant_id = $1 and is_active and kind = 'maintenance') as windows,
            (select count(*) from maintenance_windows where tenant_id = $1 and is_active and kind = 'blackout') as freezes`,
    [actor.tenantId]
  )
  return counts!
}

/* ── categories ────────────────────────────────────────────────────────── */

export type AdminCategory = CategoryRow & { ticket_count: number }

export async function listCategoriesAdmin(actor: Actor): Promise<AdminCategory[]> {
  assertPermission(actor, "admin.itsm")
  const [cats, usage] = await Promise.all([
    q<CategoryRow>(
      "select id, parent_id, name, ticket_types, sort_order, is_active from ticket_categories where tenant_id = $1 order by sort_order, lower(name)",
      [actor.tenantId]
    ),
    q<{ category_id: string; n: number }>(
      "select category_id, count(*) as n from tickets where tenant_id = $1 and category_id is not null group by category_id",
      [actor.tenantId]
    ),
  ])
  const counts = new Map(usage.map((u) => [u.category_id, u.n]))
  return cats.map((c) => ({ ...c, ticket_count: counts.get(c.id) ?? 0 }))
}

export type CategoryInput = { name: unknown; parentId?: unknown; ticketTypes?: unknown; sortOrder?: unknown; isActive?: unknown }

function categoryFriendly(e: unknown): never {
  if (isUniqueViolation(e, "ticket_categories_name_key")) throw new AppError("A category with that name already exists at this level")
  throw e
}

export async function createCategory(actor: Actor, input: CategoryInput): Promise<string> {
  assertPermission(actor, "admin.itsm")
  const name = requiredText(input.name, 100, "Name")
  const parentRaw = String(input.parentId ?? "").trim()
  try {
    return await tx(async (db) => {
      let parentId: string | null = null
      let parentName: string | null = null
      if (parentRaw) {
        if (!isUuid(parentRaw)) throw new AppError("Unknown parent category")
        const parent = await q1<{ id: string; parent_id: string | null; name: string }>(
          "select id, parent_id, name from ticket_categories where id = $1 and tenant_id = $2",
          [parentRaw, actor.tenantId],
          db
        )
        if (!parent) throw new AppError("Unknown parent category")
        if (parent.parent_id) throw new AppError("Categories have two levels: a sub-category cannot have its own sub-categories")
        parentId = parent.id
        parentName = parent.name
      }
      // sub-categories follow their category's record types
      const types = parentId ? null : parseTicketTypes(input.ticketTypes)
      const sortRaw = String(input.sortOrder ?? "").trim()
      const sortOrder = sortRaw
        ? wholeNumber(sortRaw, "Order", -100000, 100000)
        : ((
            await q1<{ n: number }>(
              "select coalesce(max(sort_order), 0) + 1 as n from ticket_categories where tenant_id = $1 and parent_id is not distinct from $2::uuid",
              [actor.tenantId, parentId],
              db
            )
          )?.n ?? 1)
      const row = await q1<{ id: string }>(
        "insert into ticket_categories (tenant_id, parent_id, name, ticket_types, sort_order) values ($1, $2, $3, $4, $5) returning id",
        [actor.tenantId, parentId, name, types, sortOrder],
        db
      )
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: "admin.category_created",
          entityType: "ticket_category",
          entityId: row!.id,
          summary: parentName ? `Sub-category ${parentName} › ${name} created` : `Category ${name} created`,
          data: { name, parent: parentName, ticket_types: types },
        },
        db
      )
      return row!.id
    })
  } catch (e) {
    categoryFriendly(e)
  }
}

export async function updateCategory(actor: Actor, id: string, input: CategoryInput): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Category not found")
  const name = requiredText(input.name, 100, "Name")
  const sortOrder = wholeNumber(input.sortOrder ?? 0, "Order", -100000, 100000)
  const isActive = bool(input.isActive)
  try {
    await tx(async (db) => {
      const before = await q1<CategoryRow>(
        "select id, parent_id, name, ticket_types, sort_order, is_active from ticket_categories where id = $1 and tenant_id = $2 for update",
        [id, actor.tenantId],
        db
      )
      if (!before) throw notFound("Category not found")
      const types = before.parent_id ? null : parseTicketTypes(input.ticketTypes)
      const changed: string[] = []
      if (before.name !== name) changed.push("name")
      if (before.sort_order !== sortOrder) changed.push("sort_order")
      if (before.is_active !== isActive) changed.push("is_active")
      if (JSON.stringify(before.ticket_types ?? null) !== JSON.stringify(types)) changed.push("ticket_types")
      if (!changed.length) return
      await exec(
        "update ticket_categories set name = $3, ticket_types = $4, sort_order = $5, is_active = $6 where id = $1 and tenant_id = $2",
        [id, actor.tenantId, name, types, sortOrder, isActive],
        db
      )
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: changed.length === 1 && changed[0] === "is_active" ? (isActive ? "admin.category_activated" : "admin.category_deactivated") : "admin.category_updated",
          entityType: "ticket_category",
          entityId: id,
          summary: `Category ${name} changed: ${changed.join(", ")}`,
          data: { fields: changed, ...(before.name !== name ? { name: { from: before.name, to: name } } : {}), ticket_types: types, is_active: isActive },
        },
        db
      )
    })
  } catch (e) {
    categoryFriendly(e)
  }
}

/** Deletes an unused category (and its sub-categories). A used one must be deactivated instead. */
export async function deleteCategory(actor: Actor, id: string): Promise<void> {
  assertPermission(actor, "admin.itsm")
  if (!isUuid(id)) throw notFound("Category not found")
  await tx(async (db) => {
    const c = await q1<{ name: string; parent_id: string | null }>("select name, parent_id from ticket_categories where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], db)
    if (!c) throw notFound("Category not found")
    const ids = [id, ...(await q<{ id: string }>("select id from ticket_categories where parent_id = $1 and tenant_id = $2", [id, actor.tenantId], db)).map((r) => r.id)]
    const used = await q1<{ n: number }>("select count(*) as n from tickets where tenant_id = $1 and category_id = any($2::uuid[])", [actor.tenantId, ids], db)
    if (used!.n > 0) {
      throw new AppError(`${used!.n} ticket${used!.n === 1 ? " uses" : "s use"} this category${ids.length > 1 ? " or its sub-categories" : ""}. Deactivate it instead.`)
    }
    const items = await q1<{ n: number }>("select count(*) as n from catalog_items where tenant_id = $1 and ticket_category_id = any($2::uuid[])", [actor.tenantId, ids], db)
    if (items!.n > 0) throw new AppError(`${items!.n} catalog item${items!.n === 1 ? " files" : "s file"} requests under this category. Deactivate it instead.`)
    await exec("delete from ticket_categories where id = $1 and tenant_id = $2", [id, actor.tenantId], db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.category_deleted",
        entityType: "ticket_category",
        entityId: id,
        summary: `Category ${c.name} deleted`,
        data: { name: c.name, sub_categories_deleted: ids.length - 1 },
      },
      db
    )
  })
}

/* ── priority matrix ───────────────────────────────────────────────────── */

/** All nine cells; a missing cell shows the ITIL default. */
export async function getMatrix(actor: Actor): Promise<MatrixCell[]> {
  assertPermission(actor, "admin.itsm")
  const rows = await q<MatrixCell>("select impact, urgency, priority from priority_matrix where tenant_id = $1", [actor.tenantId])
  const out: MatrixCell[] = []
  for (const impact of [...LEVELS].reverse()) for (const urgency of [...LEVELS].reverse()) out.push({ impact, urgency, priority: priorityFromMatrix(rows, impact, urgency) })
  return out
}

/** cells: { "high.medium": "high", … } for every impact.urgency pair. */
export async function saveMatrix(actor: Actor, cells: Record<string, unknown>): Promise<number> {
  assertPermission(actor, "admin.itsm")
  const next: MatrixCell[] = []
  for (const impact of LEVELS) {
    for (const urgency of LEVELS) {
      const v = cells[`${impact}.${urgency}`]
      if (!isPriority(v)) throw new AppError(`Choose a priority for impact ${impact} × urgency ${urgency}`)
      next.push({ impact, urgency, priority: v })
    }
  }
  return tx(async (db) => {
    const rows = await q<MatrixCell>("select impact, urgency, priority from priority_matrix where tenant_id = $1 for update", [actor.tenantId], db)
    const changes: Record<string, string> = {}
    for (const c of next) {
      const old = priorityFromMatrix(rows, c.impact as Level, c.urgency as Level)
      const stored = rows.some((r) => r.impact === c.impact && r.urgency === c.urgency)
      if (old !== c.priority || !stored) {
        if (old !== c.priority) changes[`${c.impact}×${c.urgency}`] = `${old} → ${c.priority}`
        await exec(
          `insert into priority_matrix (tenant_id, impact, urgency, priority) values ($1, $2, $3, $4)
           on conflict (tenant_id, impact, urgency) do update set priority = excluded.priority`,
          [actor.tenantId, c.impact, c.urgency, c.priority as Priority],
          db
        )
      }
    }
    const n = Object.keys(changes).length
    if (n) {
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.priority_matrix_updated", entityType: "tenant", entityId: actor.tenantId, summary: `Priority matrix: ${n} cell${n === 1 ? "" : "s"} changed`, data: { changes } },
        db
      )
    }
    return n
  })
}

/* ── calendar and ticket behaviour ─────────────────────────────────────── */

export type CalendarInput = {
  timezone: unknown
  workDays: unknown
  workStart: unknown
  workEnd: unknown
  holidays: unknown
  holdMaxHours: unknown
  reopenWindowDays: unknown
  autoCloseResolvedDays: unknown
  strictAssignment: unknown
}

export function parseCalendar(input: CalendarInput) {
  const timezone = String(input.timezone ?? "").trim()
  if (!timezone) throw new AppError("Time zone is required")
  if (timezone.length > 64 || !isValidTimeZone(timezone)) throw new AppError(`Unknown time zone "${timezone}". Use a name such as Europe/London or Asia/Kolkata.`)
  const work_start = parseTimeOfDay(input.workStart, "Work starts")
  const work_end = parseTimeOfDay(input.workEnd, "Work ends")
  if (work_end <= work_start) throw new AppError("The working day must end after it starts")
  return {
    timezone,
    work_days: parseWorkDays(input.workDays),
    work_start,
    work_end,
    holidays: parseHolidays(input.holidays),
    hold_max_hours: wholeNumber(input.holdMaxHours, "Longest hold", 1, 8760),
    reopen_window_days: wholeNumber(input.reopenWindowDays, "Reopen window", 0, 365),
    auto_close_resolved_days: wholeNumber(input.autoCloseResolvedDays, "Auto-close", 0, 365),
    strict_assignment: bool(input.strictAssignment),
  }
}

export async function saveCalendar(actor: Actor, input: CalendarInput): Promise<string[]> {
  assertPermission(actor, "admin.itsm")
  const next = parseCalendar(input)
  return tx(async (db) => {
    const before = await loadTenantSettings(actor.tenantId, db)
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))
    if (!changed.length) return []
    await exec(
      `insert into tenant_settings (tenant_id, timezone, work_days, work_start, work_end, holidays, hold_max_hours, reopen_window_days,
                                    auto_close_resolved_days, strict_assignment, updated_at)
       values ($1, $2, $3::smallint[], $4::time, $5::time, $6::date[], $7, $8, $9, $10, now())
       on conflict (tenant_id) do update set
         timezone = excluded.timezone, work_days = excluded.work_days, work_start = excluded.work_start, work_end = excluded.work_end,
         holidays = excluded.holidays, hold_max_hours = excluded.hold_max_hours, reopen_window_days = excluded.reopen_window_days,
         auto_close_resolved_days = excluded.auto_close_resolved_days, strict_assignment = excluded.strict_assignment, updated_at = now()`,
      [
        actor.tenantId,
        next.timezone,
        next.work_days,
        next.work_start,
        next.work_end,
        next.holidays,
        next.hold_max_hours,
        next.reopen_window_days,
        next.auto_close_resolved_days,
        next.strict_assignment,
      ],
      db
    )
    const data: Record<string, unknown> = {}
    for (const k of changed) {
      if (k === "holidays") {
        data.holidays = {
          added: next.holidays.filter((h) => !before.holidays.includes(h)).slice(0, 100),
          removed: before.holidays.filter((h) => !next.holidays.includes(h)).slice(0, 100),
        }
      } else data[k] = { from: before[k], to: next[k] }
    }
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.itsm_calendar_updated", entityType: "tenant", entityId: actor.tenantId, summary: `Calendar and ticket behaviour changed: ${changed.join(", ")}`, data },
      db
    )
    return changed
  })
}
