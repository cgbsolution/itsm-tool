/**
 * Service catalog service: catalog administration (catalog.manage) and request
 * submission (everyone who may raise tickets). Tickets are only ever written
 * through the ticket service (createTicket, assignTicket, addTask, addComment)
 * and approvals through requestApprovals.
 */
import { z } from "zod"
import { q, q1, exec, tx, isUuid, isUniqueViolation, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { systemActor } from "@/lib/auth/system"
import { AppError, forbidden, notFound } from "@/lib/errors"
import { parse } from "@/lib/validate"
import { audit } from "@/lib/audit"
import { PRIORITIES, type Priority } from "@/lib/itsm/vocab"
import { loadItsmConfig, resolveCategory } from "@/lib/itsm/config"
import { addComment, addTask, assignTicket, createTicket, type TicketRow } from "@/lib/itsm/tickets"
import { requestApprovals, type ApprovalPlan } from "@/lib/itsm/approvals"
import type { EventTicket } from "@/lib/itsm/events"
import {
  buildFormFields,
  describeAnswers,
  normalizeFields,
  normalizeTasks,
  parseTaskTemplates,
  requestSubject,
  requireValidValues,
  type FieldRowInput,
  type RawValue,
} from "@/lib/catalog/forms"
import { STARTER_CATEGORIES, STARTER_ITEMS } from "@/lib/catalog/starter"

export type CatalogItemRow = {
  id: string
  tenant_id: string
  category_id: string | null
  name: string
  short_description: string | null
  description: string | null
  form_fields: unknown
  requires_approval: boolean
  approval_mode: "any" | "all"
  approver_group_id: string | null
  approve_by_manager: boolean
  fulfilment_group_id: string | null
  ticket_category_id: string | null
  default_priority: Priority
  task_templates: unknown
  visibility: "all" | "staff"
  sort_order: number
  is_active: boolean
  created_at: Date
  updated_at: Date
}

export type CatalogCategoryRow = { id: string; tenant_id: string; name: string; description: string | null; sort_order: number; is_active: boolean; created_at: Date }

/** Whether the actor may see and request an item (managers can also preview inactive ones). */
export function canSeeItem(actor: Pick<Actor, "permissions">, item: Pick<CatalogItemRow, "is_active" | "visibility">): boolean {
  return item.is_active && (item.visibility === "all" || actor.permissions.has("ticket.view_all"))
}

function needManage(actor: Actor) {
  if (!actor.permissions.has("catalog.manage")) throw forbidden("Only catalog managers can change the service catalog")
}

const auditActor = (actor: Actor) => (actor.isSystem ? null : { id: actor.id, email: actor.email })

async function log(db: Db, actor: Actor, action: string, entityType: string, entityId: string | null, summary: string, data?: Record<string, unknown>) {
  await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action, entityType, entityId, summary: summary.slice(0, 300), data }, db)
}

const uuid = z.string().refine((v) => isUuid(v), "Invalid reference")

/* ── categories ────────────────────────────────────────────────────────── */

const categorySchema = z.object({
  name: z.string().trim().min(1, "Give the category a name").max(100, "Keep the name under 100 characters"),
  description: z.string().trim().max(1000, "Keep the description under 1,000 characters").nullish(),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  isActive: z.boolean().default(true),
})
export type CatalogCategoryInput = z.input<typeof categorySchema>

const duplicate = (what: string) => (e: unknown) => (isUniqueViolation(e) ? new AppError(`A ${what} with that name already exists`) : e)

export async function createCatalogCategory(actor: Actor, raw: CatalogCategoryInput): Promise<string> {
  needManage(actor)
  const input = parse(categorySchema, raw)
  try {
    return await tx(async (c) => {
      const row = await q1<{ id: string }>(
        "insert into catalog_categories (tenant_id, name, description, sort_order, is_active) values ($1, $2, $3, $4, $5) returning id",
        [actor.tenantId, input.name, input.description || null, input.sortOrder, input.isActive],
        c
      )
      await log(c, actor, "catalog.category_created", "catalog_category", row!.id, input.name)
      return row!.id
    })
  } catch (e) {
    throw duplicate("category")(e)
  }
}

export async function updateCatalogCategory(actor: Actor, id: string, raw: CatalogCategoryInput): Promise<void> {
  needManage(actor)
  if (!isUuid(id)) throw notFound("Category not found")
  const input = parse(categorySchema, raw)
  try {
    await tx(async (c) => {
      const before = await q1<CatalogCategoryRow>("select * from catalog_categories where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], c)
      if (!before) throw notFound("Category not found")
      await exec(
        "update catalog_categories set name = $3, description = $4, sort_order = $5, is_active = $6 where id = $1 and tenant_id = $2",
        [id, actor.tenantId, input.name, input.description || null, input.sortOrder, input.isActive],
        c
      )
      await log(c, actor, "catalog.category_updated", "catalog_category", id, input.name, {
        before: { name: before.name, sort_order: before.sort_order, is_active: before.is_active },
        after: { name: input.name, sort_order: input.sortOrder, is_active: input.isActive },
      })
    })
  } catch (e) {
    throw duplicate("category")(e)
  }
}

/** Deletes a category; its items stay, without a category. */
export async function deleteCatalogCategory(actor: Actor, id: string): Promise<void> {
  needManage(actor)
  if (!isUuid(id)) throw notFound("Category not found")
  await tx(async (c) => {
    const row = await q1<{ name: string }>("delete from catalog_categories where id = $1 and tenant_id = $2 returning name", [id, actor.tenantId], c)
    if (!row) throw notFound("Category not found")
    await log(c, actor, "catalog.category_deleted", "catalog_category", id, row.name)
  })
}

/* ── items ─────────────────────────────────────────────────────────────── */

const itemSchema = z
  .object({
    name: z.string().trim().min(2, "Give the item a name of at least 2 characters").max(200, "Keep the name under 200 characters"),
    categoryId: uuid.nullish(),
    shortDescription: z.string().trim().max(300, "Keep the short description under 300 characters").nullish(),
    description: z.string().max(20_000, "The description is too long").nullish(),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
    visibility: z.enum(["all", "staff"], { message: "Choose who can see the item" }),
    defaultPriority: z.enum(PRIORITIES, { message: "Choose a default priority" }),
    ticketCategoryId: uuid.nullish(),
    fulfilmentGroupId: uuid.nullish(),
    requiresApproval: z.boolean(),
    approvalMode: z.enum(["any", "all"], { message: "Choose how the approver group decides" }),
    approverGroupId: uuid.nullish(),
    approveByManager: z.boolean(),
  })
  .refine((v) => !v.requiresApproval || v.approveByManager || !!v.approverGroupId, {
    message: "An item that needs approval needs an approver: tick manager approval or choose an approver group",
  })
export type CatalogItemInput = z.input<typeof itemSchema>

async function checkRefs(db: Db, actor: Actor, input: z.output<typeof itemSchema>) {
  if (input.categoryId && !(await q1("select 1 from catalog_categories where id = $1 and tenant_id = $2", [input.categoryId, actor.tenantId], db))) {
    throw new AppError("That catalog category does not exist")
  }
  for (const [gid, label] of [
    [input.fulfilmentGroupId, "fulfilment group"],
    [input.approverGroupId, "approver group"],
  ] as const) {
    if (gid && !(await q1("select 1 from groups where id = $1 and tenant_id = $2 and is_active", [gid, actor.tenantId], db))) {
      throw new AppError(`That ${label} does not exist`)
    }
  }
  if (input.ticketCategoryId) {
    const cfg = await loadItsmConfig(actor.tenantId, db)
    resolveCategory(cfg, "service_request", input.ticketCategoryId) // throws a readable error
  }
}

const ITEM_COLUMNS = {
  category_id: (i: z.output<typeof itemSchema>) => i.categoryId ?? null,
  name: (i: z.output<typeof itemSchema>) => i.name,
  short_description: (i: z.output<typeof itemSchema>) => i.shortDescription || null,
  description: (i: z.output<typeof itemSchema>) => i.description?.trim() || null,
  is_active: (i: z.output<typeof itemSchema>) => i.isActive,
  sort_order: (i: z.output<typeof itemSchema>) => i.sortOrder,
  visibility: (i: z.output<typeof itemSchema>) => i.visibility,
  default_priority: (i: z.output<typeof itemSchema>) => i.defaultPriority,
  ticket_category_id: (i: z.output<typeof itemSchema>) => i.ticketCategoryId ?? null,
  fulfilment_group_id: (i: z.output<typeof itemSchema>) => i.fulfilmentGroupId ?? null,
  requires_approval: (i: z.output<typeof itemSchema>) => i.requiresApproval,
  approval_mode: (i: z.output<typeof itemSchema>) => i.approvalMode,
  approver_group_id: (i: z.output<typeof itemSchema>) => i.approverGroupId ?? null,
  approve_by_manager: (i: z.output<typeof itemSchema>) => i.approveByManager,
} as const

export async function createCatalogItem(actor: Actor, raw: CatalogItemInput, db?: Db): Promise<string> {
  needManage(actor)
  const input = parse(itemSchema, raw)
  const run = async (c: Db) => {
    await checkRefs(c, actor, input)
    const cols = Object.keys(ITEM_COLUMNS) as (keyof typeof ITEM_COLUMNS)[]
    const row = await q1<{ id: string }>(
      `insert into catalog_items (tenant_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
      [actor.tenantId, ...cols.map((col) => ITEM_COLUMNS[col](input))],
      c
    )
    await log(c, actor, "catalog.item_created", "catalog_item", row!.id, input.name)
    return row!.id
  }
  return db ? run(db) : tx(run)
}

export async function updateCatalogItem(actor: Actor, id: string, raw: CatalogItemInput): Promise<void> {
  needManage(actor)
  if (!isUuid(id)) throw notFound("Item not found")
  const input = parse(itemSchema, raw)
  await tx(async (c) => {
    const before = await q1<CatalogItemRow>("select * from catalog_items where id = $1 and tenant_id = $2 for update", [id, actor.tenantId], c)
    if (!before) throw notFound("Item not found")
    await checkRefs(c, actor, input)
    const cols = Object.keys(ITEM_COLUMNS) as (keyof typeof ITEM_COLUMNS)[]
    const values = cols.map((col) => ITEM_COLUMNS[col](input))
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    cols.forEach((col, i) => {
      const from = (before as unknown as Record<string, unknown>)[col] ?? null
      if (from !== values[i]) changes[col] = { from: col === "description" ? "(text)" : from, to: col === "description" ? "(text)" : values[i] }
    })
    if (!Object.keys(changes).length) return
    await exec(
      `update catalog_items set ${cols.map((col, i) => `${col} = $${i + 3}`).join(", ")}, updated_at = now() where id = $1 and tenant_id = $2`,
      [id, actor.tenantId, ...values],
      c
    )
    await log(c, actor, "catalog.item_updated", "catalog_item", id, `${input.name}: ${Object.keys(changes).join(", ")}`, { changes })
  })
}

export async function deleteCatalogItem(actor: Actor, id: string): Promise<void> {
  needManage(actor)
  if (!isUuid(id)) throw notFound("Item not found")
  await tx(async (c) => {
    const row = await q1<{ name: string }>("delete from catalog_items where id = $1 and tenant_id = $2 returning name", [id, actor.tenantId], c)
    if (!row) throw notFound("Item not found")
    await log(c, actor, "catalog.item_deleted", "catalog_item", id, row.name)
  })
}

/** Saves the form builder rows (validated: keys, uniqueness, labels, types, options). */
export async function setCatalogItemForm(actor: Actor, id: string, rows: FieldRowInput[]): Promise<number> {
  needManage(actor)
  if (!isUuid(id)) throw notFound("Item not found")
  const fields = buildFormFields(rows)
  return tx(async (c) => {
    const item = await q1<{ name: string }>("update catalog_items set form_fields = $3, updated_at = now() where id = $1 and tenant_id = $2 returning name", [id, actor.tenantId, JSON.stringify(fields)], c)
    if (!item) throw notFound("Item not found")
    await log(c, actor, "catalog.item_form_updated", "catalog_item", id, `${item.name}: ${fields.length} fields`, { keys: fields.map((f) => f.key) })
    return fields.length
  })
}

/** Saves the fulfilment task templates ("one per line"). */
export async function setCatalogItemTasks(actor: Actor, id: string, text: string): Promise<number> {
  needManage(actor)
  if (!isUuid(id)) throw notFound("Item not found")
  const tasks = parseTaskTemplates(text)
  return tx(async (c) => {
    const item = await q1<{ name: string }>("update catalog_items set task_templates = $3, updated_at = now() where id = $1 and tenant_id = $2 returning name", [id, actor.tenantId, JSON.stringify(tasks)], c)
    if (!item) throw notFound("Item not found")
    await log(c, actor, "catalog.item_tasks_updated", "catalog_item", id, `${item.name}: ${tasks.length} tasks`, { tasks: tasks.map((t) => t.title) })
    return tasks.length
  })
}

/** Creates the four starter items (and their categories) unless items with those names exist. */
export async function createStarterItems(actor: Actor): Promise<{ created: string[]; skipped: string[] }> {
  needManage(actor)
  return tx(async (c) => {
    const created: string[] = []
    const skipped: string[] = []
    const categoryIds = new Map<string, string>()
    for (const item of STARTER_ITEMS) {
      if (await q1("select 1 from catalog_items where tenant_id = $1 and lower(name) = lower($2)", [actor.tenantId, item.name], c)) {
        skipped.push(item.name)
        continue
      }
      let categoryId = categoryIds.get(item.category)
      if (!categoryId) {
        const existing = await q1<{ id: string }>("select id from catalog_categories where tenant_id = $1 and lower(name) = lower($2)", [actor.tenantId, item.category], c)
        categoryId =
          existing?.id ??
          (await q1<{ id: string }>(
            `insert into catalog_categories (tenant_id, name, description, sort_order)
             values ($1, $2, $3, (select coalesce(max(sort_order), 0) + 10 from catalog_categories where tenant_id = $1)) returning id`,
            [actor.tenantId, item.category, STARTER_CATEGORIES[item.category] ?? null],
            c
          ))!.id
        categoryIds.set(item.category, categoryId)
      }
      await q1(
        `insert into catalog_items (tenant_id, category_id, name, short_description, description, form_fields, requires_approval, approval_mode,
                                    approve_by_manager, default_priority, task_templates, visibility, sort_order, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, 'any', $8, $9, $10, 'all', $11, true)`,
        [
          actor.tenantId, categoryId, item.name, item.shortDescription, item.description, JSON.stringify(item.fields), item.requiresApproval,
          item.approveByManager, item.priority, JSON.stringify(item.tasks), (created.length + 1) * 10,
        ],
        c
      )
      created.push(item.name)
    }
    if (created.length) await log(c, actor, "catalog.starter_items_created", "catalog_item", null, created.join(", "), { created, skipped })
    return { created, skipped }
  })
}

/* ── requests ──────────────────────────────────────────────────────────── */

function eventTicketOf(t: TicketRow): EventTicket {
  return {
    id: t.id,
    tenant_id: t.tenant_id,
    number: t.number,
    ticket_type: t.ticket_type,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    requester_id: t.requester_id,
    assignee_id: t.assignee_id,
    assignment_group_id: t.assignment_group_id,
    created_by: t.created_by,
    resolution_notes: t.resolution_notes,
  }
}

/**
 * Approval steps for a request: (1) the requester's manager when the item asks for
 * it and an active manager exists; (2) the approver group with the item's mode.
 * Steps without anyone who could decide are left out (the requester can never
 * approve their own request), so an empty plan means "no approval needed".
 */
async function approvalSteps(db: Db, actor: Actor, item: CatalogItemRow): Promise<ApprovalPlan["steps"]> {
  const steps: ApprovalPlan["steps"] = []
  if (!item.requires_approval) return steps
  if (item.approve_by_manager && !actor.isSystem) {
    const m = await q1<{ id: string }>(
      `select m.id from users u join users m on m.id = u.manager_id
        where u.id = $1 and u.tenant_id = $2 and m.tenant_id = $2 and m.status = 'active'`,
      [actor.id, actor.tenantId],
      db
    )
    if (m && m.id !== actor.id) steps.push({ approverIds: [m.id], mode: "any" })
  }
  if (item.approver_group_id) {
    const members = await q<{ user_id: string; active: boolean }>(
      `select gm.user_id, (u.status = 'active' and u.tenant_id = g.tenant_id) as active
         from groups g join group_members gm on gm.group_id = g.id join users u on u.id = gm.user_id
        where g.id = $1 and g.tenant_id = $2 and g.is_active`,
      [item.approver_group_id, actor.tenantId],
      db
    )
    const deciders = members.filter((m) => m.active && m.user_id !== actor.id).map((m) => m.user_id)
    if (deciders.length) {
      // "all" over the whole group would wait forever on the requester or a disabled member:
      // name the members who can decide instead.
      const clean = deciders.length === members.length
      steps.push(item.approval_mode === "all" && !clean ? { approverIds: deciders, mode: "all" } : { groupId: item.approver_group_id, mode: item.approval_mode })
    }
  }
  return steps
}

/**
 * Raises a service request from a catalog item, in one transaction:
 * validates the answers, creates the ticket (requester = actor), routes it to the
 * fulfilment group, adds the template tasks, and requests approvals when needed.
 * Returns the created ticket (redirect to /tickets/<number>).
 */
export async function submitRequest(actor: Actor, itemId: string, values: Record<string, RawValue>, db?: Db): Promise<TicketRow> {
  if (!isUuid(itemId)) throw notFound("That catalog item does not exist")
  const run = async (c: Db) => {
    const item = await q1<CatalogItemRow>("select * from catalog_items where id = $1 and tenant_id = $2", [itemId, actor.tenantId], c)
    if (!item || !canSeeItem(actor, item)) throw notFound("That catalog item does not exist or is no longer offered")
    const fields = normalizeFields(item.form_fields)
    const answers = requireValidValues(fields, values)

    // a misconfigured link must not stop people from requesting
    let categoryId: string | null = null
    if (item.ticket_category_id) {
      try {
        resolveCategory(await loadItsmConfig(actor.tenantId, c), "service_request", item.ticket_category_id)
        categoryId = item.ticket_category_id
      } catch {
        categoryId = null
      }
    }
    const steps = await approvalSteps(c, actor, item)
    const summary = describeAnswers(item.name, fields, answers)

    // 1. the ticket
    let ticket = await createTicket(
      actor,
      {
        type: "service_request",
        subject: requestSubject(item.name, fields, answers),
        description: summary,
        catalogItemId: item.id,
        formData: answers,
        categoryId,
        priority: item.default_priority,
        needsApproval: steps.length > 0,
      },
      c
    )
    const sys = systemActor(actor.tenantId)

    // 2. route to the fulfilment group
    if (item.fulfilment_group_id && (await q1("select 1 from groups where id = $1 and tenant_id = $2 and is_active", [item.fulfilment_group_id, actor.tenantId], c))) {
      ticket = await assignTicket(sys, ticket.id, { groupId: item.fulfilment_group_id }, c)
    }

    // 3. fulfilment tasks
    for (const t of normalizeTasks(item.task_templates)) await addTask(sys, ticket.id, t.title, {}, c)

    // 4. approvals
    if (steps.length) {
      await requestApprovals(c, actor, eventTicketOf(ticket), {
        steps,
        details: `Catalog request "${item.name}" from ${actor.name}.\n\n${summary.split("\n").slice(2).join("\n")}`.slice(0, 2000),
      })
    } else if (item.requires_approval) {
      await addComment(
        sys,
        ticket.id,
        {
          body: "This catalog item needs approval, but nobody could approve it (no active manager and no approver group member other than the requester), so it went straight to fulfilment. Check the item's approval settings.",
          internal: true,
        },
        c
      )
    }
    return (await q1<TicketRow>("select * from tickets where id = $1 and tenant_id = $2", [ticket.id, actor.tenantId], c))!
  }
  return db ? run(db) : tx(run)
}
