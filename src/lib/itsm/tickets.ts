/**
 * Ticket service: the only code that writes tickets. Pages, server actions,
 * the REST API, email-to-ticket and jobs all call these functions, so the same
 * tenant checks, access rules, workflow, SLA and notifications apply everywhere.
 */
import { z } from "zod"
import { q, q1, exec, tx, type Db, isUuid } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { actorId } from "@/lib/auth/system"
import { AppError, conflict, forbidden, notFound } from "@/lib/errors"
import { parse } from "@/lib/validate"
import { loadItsmConfig, resolveCategory, resolveCustomFields, resolvePriority, type ItsmConfig } from "@/lib/itsm/config"
import { ticketAccess, type TicketAccess } from "@/lib/itsm/access"
import { availableTransitions, initialStatus, isTerminal, workingStatus, type Status } from "@/lib/itsm/workflow"
import {
  CHANGE_OUTCOMES,
  CHANGE_TYPES,
  LEVELS,
  LINK_TYPES,
  PRIORITIES,
  REQUESTER_TICKET_TYPES,
  RISKS,
  SOURCES,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  TICKET_TYPE_PREFIX,
  type Priority,
  type TicketType,
} from "@/lib/itsm/vocab"
import * as sla from "@/lib/itsm/sla"
import { ticketEvent } from "@/lib/itsm/events"
import { cancelPendingApprovals, requestApprovals } from "@/lib/itsm/approvals"
import { overlapsBlackout, windowsFor } from "@/lib/itsm/windows"
import { audit } from "@/lib/audit"

export type TicketRow = {
  id: string
  tenant_id: string
  number: string
  ticket_type: TicketType
  status: Status
  subject: string
  description: string | null
  source: string
  requester_id: string | null
  requester_name: string | null
  created_by: string | null
  organization_id: string | null
  contact: string | null
  location: string | null
  category_id: string | null
  category: string | null
  sub_category: string | null
  impact: string | null
  urgency: string | null
  priority: Priority
  assignment_group_id: string | null
  assignee_id: string | null
  assigned_at: Date | null
  first_response_at: Date | null
  resolved_at: Date | null
  closed_at: Date | null
  resolution_code: string | null
  resolution_notes: string | null
  close_comment: string | null
  hold_reason: string | null
  hold_started_at: Date | null
  hold_until: Date | null
  sla_response_due: Date | null
  sla_resolution_due: Date | null
  sla_response_breached: boolean
  sla_resolution_breached: boolean
  root_cause: string | null
  workaround: string | null
  known_error: boolean
  change_type: string | null
  risk: string | null
  justification: string | null
  implementation_plan: string | null
  backout_plan: string | null
  test_plan: string | null
  planned_start: Date | null
  planned_end: Date | null
  actual_start: Date | null
  actual_end: Date | null
  change_outcome: string | null
  cab_group_id: string | null
  catalog_item_id: string | null
  form_data: Record<string, unknown>
  custom: Record<string, unknown>
  legacy: Record<string, unknown> | null
  version: number
  created_at: Date
  updated_at: Date
}

const text = (max: number) => z.string().max(max).nullish()
const id = z.string().refine((v) => isUuid(v), "Invalid reference").nullish()

export const createTicketSchema = z.object({
  type: z.enum(TICKET_TYPES),
  subject: z.string().trim().min(3, "Write a subject of at least 3 characters").max(300, "Keep the subject under 300 characters"),
  description: text(50_000),
  requesterId: id,
  requesterName: text(200),
  categoryId: id,
  impact: z.enum(LEVELS).nullish(),
  urgency: z.enum(LEVELS).nullish(),
  priority: z.enum(PRIORITIES).nullish(),
  assignmentGroupId: id,
  assigneeId: id,
  contact: text(200),
  location: text(200),
  organizationId: id,
  custom: z.record(z.string(), z.unknown()).optional(),
  ciIds: z.array(z.string().refine(isUuid)).max(50).optional(),
  changeType: z.enum(CHANGE_TYPES).nullish(),
  risk: z.enum(RISKS).nullish(),
  justification: text(50_000),
  implementationPlan: text(50_000),
  backoutPlan: text(50_000),
  testPlan: text(50_000),
  plannedStart: z.date().nullish(),
  plannedEnd: z.date().nullish(),
  cabGroupId: id,
  rootCause: text(50_000),
  workaround: text(50_000),
  catalogItemId: id,
  formData: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(SOURCES).optional(),
  needsApproval: z.boolean().optional(),
})
export type CreateTicketInput = z.input<typeof createTicketSchema>

/* ── helpers ───────────────────────────────────────────────────────────── */

async function activity(db: Db, t: { id: string; tenant_id: string }, actor: Actor, action: string, details: Record<string, unknown> = {}) {
  await exec(
    "insert into ticket_activity (tenant_id, ticket_id, actor_id, action, details) values ($1, $2, $3, $4, $5)",
    [t.tenant_id, t.id, actorId(actor), action, JSON.stringify(details)],
    db
  )
}

async function lockTicket(db: Db, actor: Actor, ticketId: string): Promise<TicketRow> {
  if (!isUuid(ticketId)) throw notFound("Ticket not found")
  const t = await q1<TicketRow>("select * from tickets where id = $1 and tenant_id = $2 for update", [ticketId, actor.tenantId], db)
  if (!t) throw notFound("Ticket not found")
  return t
}

async function isWatcher(db: Db, ticketId: string, userId: string) {
  return !!(await q1("select 1 from ticket_watchers where ticket_id = $1 and user_id = $2", [ticketId, userId], db))
}

export async function accessFor(db: Db, actor: Actor, t: TicketRow, config?: ItsmConfig): Promise<TicketAccess> {
  const reopenWindowDays = config?.settings.reopen_window_days ?? 7
  return ticketAccess(
    {
      id: actor.id,
      tenantId: actor.tenantId,
      permissions: actor.permissions,
      groupIds: actor.groupIds,
      strictAssignment: actor.isSystem ? false : actor.tenant.strictAssignment,
    },
    t,
    { isWatcher: actor.isSystem ? false : await isWatcher(db, t.id, actor.id), reopenWindowDays }
  )
}

/** A staff member of the tenant who can work tickets. */
async function assertAssignable(db: Db, tenantId: string, userId: string) {
  const u = await q1<{ id: string }>(
    `select u.id from users u left join custom_roles r on r.tenant_id = u.tenant_id and r.key = u.role
      where u.id = $1 and u.tenant_id = $2 and u.status = 'active'
        and (u.role in ('engineer', 'admin', 'superadmin') or 'ticket.work' = any(coalesce(r.permissions, '{}')))`,
    [userId, tenantId],
    db
  )
  if (!u) throw new AppError("That person cannot be assigned tickets")
}

async function assertGroup(db: Db, tenantId: string, groupId: string) {
  const g = await q1("select 1 from groups where id = $1 and tenant_id = $2 and is_active", [groupId, tenantId], db)
  if (!g) throw new AppError("That group does not exist")
}

async function defaultCabGroup(db: Db, tenantId: string): Promise<string | null> {
  const g = await q1<{ id: string }>("select id from groups where tenant_id = $1 and kind = 'cab' and is_active order by created_at limit 1", [tenantId], db)
  return g?.id ?? null
}

async function reload(db: Db, ticketId: string): Promise<TicketRow> {
  return (await q1<TicketRow>("select * from tickets where id = $1", [ticketId], db))!
}

function eventTicket(t: TicketRow) {
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

function run<T>(db: Db | undefined, fn: (db: Db) => Promise<T>): Promise<T> {
  return db ? fn(db) : tx(fn)
}

/* ── create ────────────────────────────────────────────────────────────── */

export async function createTicket(actor: Actor, raw: CreateTicketInput, db?: Db): Promise<TicketRow> {
  const input = parse(createTicketSchema, raw)
  return run(db, async (c) => {
    const perms = actor.permissions
    const isStaff = perms.has("ticket.view_all")
    if (!perms.has("ticket.create")) throw forbidden("You cannot raise tickets")
    if (input.type === "problem" && !perms.has("problem.manage")) throw forbidden("You cannot raise problems")
    if (input.type === "change" && !perms.has("change.manage")) throw forbidden("You cannot raise changes")
    if (!isStaff && !REQUESTER_TICKET_TYPES.includes(input.type)) throw forbidden("You can raise incidents and requests only")

    const cfg = await loadItsmConfig(actor.tenantId, c)
    const cat = resolveCategory(cfg, input.type, input.categoryId)
    const pri = resolvePriority(cfg, input, isStaff)
    const custom = resolveCustomFields(cfg, input.type, input.custom)

    let requesterId = actorId(actor)
    let requesterName: string | null = actor.isSystem ? input.requesterName ?? null : actor.name
    if (input.requesterId && (isStaff || actor.isSystem)) {
      const r = await q1<{ id: string; full_name: string; email: string }>(
        "select id, full_name, email from users where id = $1 and tenant_id = $2",
        [input.requesterId, actor.tenantId],
        c
      )
      if (!r) throw new AppError("That requester does not exist")
      requesterId = r.id
      requesterName = r.full_name || r.email
    }

    let groupId: string | null = null
    let assigneeId: string | null = null
    if (perms.has("ticket.work")) {
      if (input.assignmentGroupId) {
        await assertGroup(c, actor.tenantId, input.assignmentGroupId)
        groupId = input.assignmentGroupId
      }
      if (input.assigneeId) {
        if (input.assigneeId !== actor.id && !perms.has("ticket.assign")) throw forbidden("You can only assign tickets to yourself")
        await assertAssignable(c, actor.tenantId, input.assigneeId)
        assigneeId = input.assigneeId
      }
    }

    let changeType: string | null = null
    let cabGroupId: string | null = null
    if (input.type === "change") {
      changeType = input.changeType ?? "normal"
      cabGroupId = input.cabGroupId ?? (await defaultCabGroup(c, actor.tenantId))
      if (input.cabGroupId) await assertGroup(c, actor.tenantId, input.cabGroupId)
      if (input.plannedStart && input.plannedEnd && input.plannedEnd <= input.plannedStart) {
        throw new AppError("The planned end must be after the planned start")
      }
    }

    const status = initialStatus(input.type, { needsApproval: input.needsApproval })
    const numberRow = await q1<{ n: string }>("select next_number($1, $2, $3) as n", [actor.tenantId, input.type, TICKET_TYPE_PREFIX[input.type]], c)
    const now = new Date()

    const row = await q1<TicketRow>(
      `insert into tickets (
         tenant_id, number, ticket_type, status, subject, description, source, requester_id, requester_name, created_by,
         organization_id, contact, location, category_id, category, sub_category, impact, urgency, priority,
         assignment_group_id, assignee_id, assigned_at, custom, change_type, risk, justification, implementation_plan,
         backout_plan, test_plan, planned_start, planned_end, cab_group_id, root_cause, workaround, catalog_item_id,
         form_data, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
               $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $37)
       returning *`,
      [
        actor.tenantId, numberRow!.n, input.type, status, input.subject, input.description ?? null, input.source ?? (actor.isSystem ? "api" : "portal"),
        requesterId, requesterName, actorId(actor), input.organizationId ?? null, input.contact ?? null, input.location ?? null,
        cat.category_id, cat.category, cat.sub_category, pri.impact, pri.urgency, pri.priority, groupId, assigneeId,
        assigneeId ? now : null, JSON.stringify(custom), changeType, input.type === "change" ? input.risk ?? null : null,
        input.justification ?? null, input.implementationPlan ?? null, input.backoutPlan ?? null, input.testPlan ?? null,
        input.plannedStart ?? null, input.plannedEnd ?? null, cabGroupId, input.rootCause ?? null, input.workaround ?? null,
        input.catalogItemId ?? null, JSON.stringify(input.formData ?? {}), now,
      ],
      c
    )
    const t = row!
    await activity(c, t, actor, "created", { status, priority: t.priority, source: t.source })
    if (assigneeId) {
      await exec(
        "insert into ticket_assignments (tenant_id, ticket_id, user_id, group_id, action, assigned_by) values ($1, $2, $3, $4, 'assigned', $5)",
        [t.tenant_id, t.id, assigneeId, groupId, actorId(actor)],
        c
      )
    }
    for (const ciId of input.ciIds ?? []) {
      await exec(
        `insert into ticket_cis (ticket_id, ci_id, role, linked_by)
         select $1, id, $3, $4 from configuration_items where id = $2 and tenant_id = $5
         on conflict do nothing`,
        [t.id, ciId, input.type === "change" ? "changed" : "affected", actorId(actor), t.tenant_id],
        c
      )
    }
    await sla.startClocks(c, t, cfg, now)
    if (assigneeId) {
      await sla.markResponded(c, t.id, now)
      await sla.markOlaResponded(c, t.id, now)
    }
    const fresh = await reload(c, t.id)
    await ticketEvent(c, eventTicket(fresh), actorId(actor), { kind: "created", onBehalf: requesterId !== actorId(actor) })
    if (assigneeId) await ticketEvent(c, eventTicket(fresh), actorId(actor), { kind: "assigned", previousAssigneeId: null })
    return fresh
  })
}

/* ── update fields ─────────────────────────────────────────────────────── */

export const updateTicketSchema = z.object({
  subject: z.string().trim().min(3).max(300).optional(),
  description: text(50_000),
  categoryId: id,
  impact: z.enum(LEVELS).nullish(),
  urgency: z.enum(LEVELS).nullish(),
  priority: z.enum(PRIORITIES).nullish(),
  contact: text(200),
  location: text(200),
  custom: z.record(z.string(), z.unknown()).optional(),
  rootCause: text(50_000),
  workaround: text(50_000),
  knownError: z.boolean().optional(),
  changeType: z.enum(CHANGE_TYPES).nullish(),
  risk: z.enum(RISKS).nullish(),
  justification: text(50_000),
  implementationPlan: text(50_000),
  backoutPlan: text(50_000),
  testPlan: text(50_000),
  plannedStart: z.date().nullish(),
  plannedEnd: z.date().nullish(),
  cabGroupId: id,
})
export type UpdateTicketInput = z.input<typeof updateTicketSchema>

const FIELD_COLUMNS: Record<string, string> = {
  subject: "subject",
  description: "description",
  contact: "contact",
  location: "location",
  rootCause: "root_cause",
  workaround: "workaround",
  knownError: "known_error",
  changeType: "change_type",
  risk: "risk",
  justification: "justification",
  implementationPlan: "implementation_plan",
  backoutPlan: "backout_plan",
  testPlan: "test_plan",
  plannedStart: "planned_start",
  plannedEnd: "planned_end",
  cabGroupId: "cab_group_id",
}

const CHANGE_PLAN_FIELDS = new Set(["changeType", "risk", "justification", "implementationPlan", "backoutPlan", "testPlan", "plannedStart", "plannedEnd", "cabGroupId"])

function same(a: unknown, b: unknown) {
  if (a instanceof Date || b instanceof Date) return (a ? new Date(a as Date).getTime() : null) === (b ? new Date(b as Date).getTime() : null)
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export async function updateTicket(actor: Actor, ticketId: string, version: number, raw: UpdateTicketInput): Promise<TicketRow> {
  const input = parse(updateTicketSchema, raw)
  return tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    if (version !== t.version) throw conflict()
    const cfg = await loadItsmConfig(t.tenant_id, c)
    const access = await accessFor(c, actor, t, cfg)
    if (!access.canWork) throw forbidden("Only the assignee (or an administrator) can edit this ticket")
    if (isTerminal(t.status)) throw new AppError("Closed tickets cannot be edited. Reopen it first.")

    const set: Record<string, unknown> = {}
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const put = (col: string, value: unknown, label = col) => {
      const before = (t as unknown as Record<string, unknown>)[col]
      if (same(before, value)) return
      set[col] = value
      changes[label] = { from: before ?? null, to: value ?? null }
    }

    for (const [key, col] of Object.entries(FIELD_COLUMNS)) {
      if (!(key in input)) continue
      const value = (input as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (CHANGE_PLAN_FIELDS.has(key)) {
        if (t.ticket_type !== "change") continue
        if (!["draft", "assessment"].includes(t.status)) throw new AppError("Move the change back to draft to edit its plan")
      }
      if ((key === "rootCause" || key === "workaround" || key === "knownError") && t.ticket_type !== "problem") continue
      put(col, value ?? null)
    }
    if (input.cabGroupId) await assertGroup(c, t.tenant_id, input.cabGroupId)
    const start = (set.planned_start as Date | undefined) ?? t.planned_start
    const end = (set.planned_end as Date | undefined) ?? t.planned_end
    if (start && end && new Date(end) <= new Date(start)) throw new AppError("The planned end must be after the planned start")

    if ("categoryId" in input && input.categoryId !== undefined) {
      const cat = resolveCategory(cfg, t.ticket_type, input.categoryId)
      put("category_id", cat.category_id, "category")
      set.category = cat.category
      set.sub_category = cat.sub_category
    }
    if (input.impact !== undefined || input.urgency !== undefined || input.priority !== undefined) {
      const pri = resolvePriority(
        cfg,
        {
          impact: input.impact === undefined ? t.impact : input.impact,
          urgency: input.urgency === undefined ? t.urgency : input.urgency,
          priority: input.priority ?? undefined,
        },
        true
      )
      put("impact", pri.impact)
      put("urgency", pri.urgency)
      put("priority", input.priority && !(input.impact || input.urgency) ? input.priority : pri.priority)
    }
    if (input.custom) {
      const values = resolveCustomFields(cfg, t.ticket_type, input.custom, { partial: true })
      const merged = { ...t.custom, ...values }
      put("custom", merged)
      if (set.custom) set.custom = JSON.stringify(merged)
    }

    if (Object.keys(set).length === 0) return t
    const cols = Object.keys(set)
    await exec(
      `update tickets set ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")}, version = version + 1, updated_at = now() where id = $1`,
      [t.id, ...cols.map((col) => set[col])],
      c
    )
    await activity(c, t, actor, "updated", { changes })
    const fresh = await reload(c, t.id)
    if ("priority" in set) await sla.onPriorityChange(c, fresh, cfg, new Date())
    return reload(c, t.id)
  })
}

/* ── workflow transitions ──────────────────────────────────────────────── */

export type TransitionInput = {
  version?: number
  comment?: string | null
  holdReason?: string | null
  holdHours?: number | string | null
  resolutionCode?: string | null
  resolutionNotes?: string | null
  rootCause?: string | null
  workaround?: string | null
  outcome?: string | null
}

function need(value: string | null | undefined, message: string): string {
  const v = value?.trim()
  if (!v) throw new AppError(message)
  return v.slice(0, 50_000)
}

export async function transitionTicket(actor: Actor, ticketId: string, action: string, data: TransitionInput, db?: Db): Promise<TicketRow> {
  return run(db, async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    if (data.version !== undefined && data.version !== t.version) throw conflict()
    const cfg = await loadItsmConfig(t.tenant_id, c)
    const access = await accessFor(c, actor, t, cfg)
    const allowed = actor.isSystem ? availableTransitions(t.ticket_type, t.status, ["system", "worker"]) : access.transitions
    const tr = allowed.find((x) => x.action === action)
    if (!tr) throw new AppError("That action is not available for this ticket now")

    const now = new Date()
    const set: Record<string, unknown> = { status: tr.to }
    let comment = data.comment?.trim() || null
    const requires = new Set(tr.requires ?? [])
    if (requires.has("comment") && !comment && !actor.isSystem) throw new AppError("Please give a reason")

    switch (action) {
      case "hold": {
        const reason = need(data.holdReason ?? comment, "Give a reason for the hold")
        const hours = Math.min(Math.max(Number(data.holdHours) || 24, 1), cfg.settings.hold_max_hours)
        set.hold_reason = reason
        set.hold_started_at = now
        set.hold_until = new Date(now.getTime() + hours * 3_600_000)
        comment = `${reason} (until ${hours} h from now)`
        break
      }
      case "resume":
        set.hold_reason = null
        set.hold_started_at = null
        set.hold_until = null
        break
      case "resolve": {
        if (t.ticket_type === "problem") {
          set.root_cause = need(data.rootCause ?? t.root_cause, "Record the root cause")
        } else {
          set.resolution_code = need(data.resolutionCode, "Choose a resolution code")
          set.resolution_notes = need(data.resolutionNotes, "Describe the resolution")
        }
        set.resolved_at = now
        set.hold_reason = null
        set.hold_started_at = null
        set.hold_until = null
        break
      }
      case "known_error":
        set.workaround = need(data.workaround ?? t.workaround, "Describe the workaround")
        set.known_error = true
        break
      case "reopen":
      case "reopen_closed":
        set.resolved_at = null
        set.closed_at = null
        set.close_comment = null
        break
      case "close":
        set.closed_at = now
        set.close_comment = comment
        break
      case "cancel":
        set.closed_at = now
        set.close_comment = comment
        await cancelPendingApprovals(c, t.id)
        break
      case "submit":
      case "request_approval":
      case "preapproved": {
        need(t.implementation_plan, "Fill in the implementation plan first")
        need(t.backout_plan, "Fill in the back-out plan first")
        if (!t.planned_start || !t.planned_end) throw new AppError("Set the planned start and end first")
        if (action === "preapproved" && t.change_type !== "standard") throw new AppError("Only standard changes are pre-approved")
        if (action === "request_approval" && t.change_type === "standard") throw new AppError("Standard changes are pre-approved; schedule it instead")
        if (t.change_type !== "emergency") {
          const freeze = overlapsBlackout(await windowsFor(t.tenant_id, "changes", c), new Date(t.planned_start), new Date(t.planned_end))
          if (freeze) throw new AppError(`The planned window overlaps the change freeze "${freeze.name}"`)
        }
        break
      }
      case "implement": {
        if (t.change_type !== "emergency") {
          const freeze = overlapsBlackout(await windowsFor(t.tenant_id, "changes", c), now, new Date(now.getTime() + 60_000))
          if (freeze) throw new AppError(`A change freeze is in effect ("${freeze.name}")`)
        }
        set.actual_start = now
        break
      }
      case "complete": {
        const outcome = data.outcome ?? ""
        if (!(CHANGE_OUTCOMES as readonly string[]).includes(outcome)) throw new AppError("Choose the outcome of the change")
        set.change_outcome = outcome
        set.actual_end = now
        break
      }
      case "revise":
        await cancelPendingApprovals(c, t.id)
        break
    }

    const cols = Object.keys(set)
    await exec(
      `update tickets set ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")}, version = version + 1, updated_at = now() where id = $1`,
      [t.id, ...cols.map((col) => set[col])],
      c
    )
    await activity(c, t, actor, "status", { from: t.status, to: tr.to, action, comment })
    if (comment && ["reopen", "reopen_closed", "cancel"].includes(action) && !actor.isSystem) {
      await exec(
        "insert into ticket_comments (tenant_id, ticket_id, author_id, body, is_internal, source) values ($1, $2, $3, $4, false, 'web')",
        [t.tenant_id, t.id, actor.id, `${tr.label}: ${comment}`],
        c
      )
    }
    if (!actor.isSystem && access.canWork && tr.by.includes("worker")) await sla.markResponded(c, t.id, now)
    await sla.onStatusChange(c, t.id, t.status, tr.to, cfg, now)

    const fresh = await reload(c, t.id)
    if (action === "request_approval") {
      const cab = fresh.cab_group_id ?? (await defaultCabGroup(c, t.tenant_id))
      await requestApprovals(c, actor, eventTicket(fresh), {
        steps: [{ groupId: cab, mode: "any" }],
        details: `Change type: ${fresh.change_type}; risk: ${fresh.risk ?? "not set"}`,
      })
    }
    await ticketEvent(c, eventTicket(fresh), actorId(actor), { kind: "status", from: t.status, to: tr.to, comment })
    return fresh
  })
}

/* ── assignment ────────────────────────────────────────────────────────── */

/** "Acquire": an engineer takes an unassigned ticket. */
export async function acquireTicket(actor: Actor, ticketId: string): Promise<TicketRow> {
  return tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const cfg = await loadItsmConfig(t.tenant_id, c)
    const access = await accessFor(c, actor, t, cfg)
    if (!access.canAcquire) throw new AppError(t.assignee_id ? "Someone else has already picked up this ticket" : "You cannot pick up this ticket")
    const now = new Date()
    const next = workingStatus(t.ticket_type, t.status) ?? t.status
    const groupId = t.assignment_group_id ?? (actor.groupIds.length === 1 ? actor.groupIds[0] : null)
    await exec(
      "update tickets set assignee_id = $2, assigned_at = $3, status = $4, assignment_group_id = $5, version = version + 1, updated_at = now() where id = $1",
      [t.id, actor.id, now, next, groupId],
      c
    )
    await exec(
      "insert into ticket_assignments (tenant_id, ticket_id, user_id, group_id, action, assigned_by) values ($1, $2, $3, $4, 'acquired', $3)",
      [t.tenant_id, t.id, actor.id, groupId],
      c
    )
    await activity(c, t, actor, "acquired", { status: next })
    if (groupId && groupId !== t.assignment_group_id) await sla.onGroupChange(c, { ...t, assignment_group_id: groupId }, cfg, now)
    await sla.markResponded(c, t.id, now)
    await sla.markOlaResponded(c, t.id, now)
    if (next !== t.status) await sla.onStatusChange(c, t.id, t.status, next, cfg, now)
    const fresh = await reload(c, t.id)
    await ticketEvent(c, eventTicket(fresh), actor.id, { kind: "assigned", previousAssigneeId: null })
    return fresh
  })
}

/** Assign or transfer to a person and/or group. */
export async function assignTicket(
  actor: Actor,
  ticketId: string,
  input: { assigneeId?: string | null; groupId?: string | null; note?: string | null },
  db?: Db
): Promise<TicketRow> {
  return run(db, async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const cfg = await loadItsmConfig(t.tenant_id, c)
    const access = await accessFor(c, actor, t, cfg)
    if (!access.canAssign && !actor.isSystem) throw forbidden("Only the assignee or an administrator can transfer this ticket")
    const assigneeId = input.assigneeId === undefined ? t.assignee_id : input.assigneeId || null
    const groupId = input.groupId === undefined ? t.assignment_group_id : input.groupId || null
    if (assigneeId && assigneeId !== t.assignee_id) await assertAssignable(c, t.tenant_id, assigneeId)
    if (groupId && groupId !== t.assignment_group_id) await assertGroup(c, t.tenant_id, groupId)
    const assigneeChanged = assigneeId !== t.assignee_id
    const groupChanged = groupId !== t.assignment_group_id
    if (!assigneeChanged && !groupChanged) return t
    const now = new Date()

    await exec(
      `update tickets set assignee_id = $2, assignment_group_id = $3,
              assigned_at = case when $4 then $5::timestamptz else assigned_at end,
              version = version + 1, updated_at = now()
        where id = $1`,
      [t.id, assigneeId, groupId, assigneeChanged, now],
      c
    )
    if (assigneeChanged) {
      await exec("update ticket_assignments set unassigned_at = $2 where ticket_id = $1 and unassigned_at is null", [t.id, now], c)
      if (assigneeId) {
        await exec(
          "insert into ticket_assignments (tenant_id, ticket_id, user_id, group_id, action, assigned_by) values ($1, $2, $3, $4, $5, $6)",
          [t.tenant_id, t.id, assigneeId, groupId, t.assignee_id ? "reassigned" : "assigned", actorId(actor)],
          c
        )
      }
    }
    await activity(c, t, actor, "assigned", {
      from_assignee: t.assignee_id,
      to_assignee: assigneeId,
      from_group: t.assignment_group_id,
      to_group: groupId,
      note: input.note ?? null,
    })
    if (groupChanged) await sla.onGroupChange(c, { ...t, assignment_group_id: groupId }, cfg, now)
    if (assigneeId) {
      await sla.markResponded(c, t.id, now)
      await sla.markOlaResponded(c, t.id, now)
    }
    const fresh = await reload(c, t.id)
    if (assigneeChanged && assigneeId) {
      await ticketEvent(c, eventTicket(fresh), actorId(actor), { kind: "assigned", previousAssigneeId: t.assignee_id, note: input.note })
    } else if (groupChanged && groupId) {
      await ticketEvent(c, eventTicket(fresh), actorId(actor), { kind: "group_assigned", groupId })
    }
    return fresh
  })
}

/* ── conversation ──────────────────────────────────────────────────────── */

export async function addComment(
  actor: Actor,
  ticketId: string,
  input: { body: string; internal?: boolean; source?: "web" | "email" | "api"; authorLabel?: string | null },
  db?: Db
): Promise<{ id: string; ticket: TicketRow }> {
  const body = input.body?.trim()
  if (!body) throw new AppError("Write a message first")
  if (body.length > 50_000) throw new AppError("The message is too long")
  return run(db, async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const cfg = await loadItsmConfig(t.tenant_id, c)
    const access = await accessFor(c, actor, t, cfg)
    const internal = !!input.internal
    if (!actor.isSystem) {
      if (internal && !access.canCommentInternal) throw forbidden("You cannot add internal notes")
      if (!internal && !access.canCommentPublic) {
        throw forbidden(isTerminal(t.status) ? "This ticket is closed" : "Only the requester and the assignee can reply on this ticket")
      }
    }
    const row = await q1<{ id: string }>(
      `insert into ticket_comments (tenant_id, ticket_id, author_id, author_label, body, is_internal, source)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [t.tenant_id, t.id, actor.isSystem ? null : actor.id, input.authorLabel ?? null, body, internal, input.source ?? "web"],
      c
    )
    await exec("update tickets set updated_at = now() where id = $1", [t.id], c)
    const now = new Date()
    const byRequester = access.isRequester || (!!actor.isSystem && !!input.authorLabel)
    if (!internal && !byRequester && access.isStaff) await sla.markResponded(c, t.id, now)

    // a reply from the requester takes the ticket off hold
    let fresh = t
    if (!internal && byRequester && t.status === "on_hold") {
      const { systemActor } = await import("@/lib/auth/system")
      fresh = await transitionTicket(systemActor(t.tenant_id), t.id, "resume", { comment: "Requester replied" }, c)
    }
    await ticketEvent(c, eventTicket(fresh), actorId(actor), { kind: "comment", body, internal, byRequester })
    return { id: row!.id, ticket: fresh }
  })
}

/* ── links, CIs, watchers ──────────────────────────────────────────────── */

export async function linkTickets(actor: Actor, ticketId: string, otherNumber: string, linkType: string): Promise<void> {
  if (!(LINK_TYPES as readonly string[]).includes(linkType)) throw new AppError("Unknown link type")
  await tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const access = await accessFor(c, actor, t)
    if (!access.canLink) throw forbidden()
    const other = await q1<{ id: string; number: string }>(
      "select id, number from tickets where tenant_id = $1 and upper(number) = upper($2)",
      [t.tenant_id, otherNumber.trim()],
      c
    )
    if (!other) throw new AppError(`No ticket ${otherNumber}`)
    if (other.id === t.id) throw new AppError("A ticket cannot be linked to itself")
    await exec(
      `insert into ticket_links (tenant_id, from_ticket, to_ticket, link_type, created_by)
       values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [t.tenant_id, t.id, other.id, linkType, actorId(actor)],
      c
    )
    await activity(c, t, actor, "linked", { to: other.number, type: linkType })
  })
}

export async function unlinkTickets(actor: Actor, ticketId: string, linkId: string): Promise<void> {
  await tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const access = await accessFor(c, actor, t)
    if (!access.canLink) throw forbidden()
    const n = await exec("delete from ticket_links where id = $1 and tenant_id = $2 and (from_ticket = $3 or to_ticket = $3)", [linkId, t.tenant_id, t.id], c)
    if (n) await activity(c, t, actor, "unlinked", { link: linkId })
  })
}

export async function linkCi(actor: Actor, ticketId: string, ciCode: string, role: string): Promise<void> {
  if (!["affected", "caused_by", "changed", "related"].includes(role)) throw new AppError("Unknown role")
  await tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const access = await accessFor(c, actor, t)
    if (!access.canLink) throw forbidden()
    const ci = await q1<{ id: string; ci_code: string }>(
      "select id, ci_code from configuration_items where tenant_id = $1 and upper(trim(ci_code)) = upper(trim($2))",
      [t.tenant_id, ciCode],
      c
    )
    if (!ci) throw new AppError(`No configuration item ${ciCode}`)
    await exec(
      "insert into ticket_cis (ticket_id, ci_id, role, linked_by) values ($1, $2, $3, $4) on conflict (ticket_id, ci_id) do update set role = excluded.role",
      [t.id, ci.id, role, actorId(actor)],
      c
    )
    await activity(c, t, actor, "ci_linked", { ci: ci.ci_code, role })
  })
}

export async function unlinkCi(actor: Actor, ticketId: string, ciId: string): Promise<void> {
  await tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const access = await accessFor(c, actor, t)
    if (!access.canLink) throw forbidden()
    const n = await exec("delete from ticket_cis where ticket_id = $1 and ci_id = $2", [t.id, ciId], c)
    if (n) await activity(c, t, actor, "ci_unlinked", { ci: ciId })
  })
}

export async function setWatching(actor: Actor, ticketId: string, watch: boolean): Promise<void> {
  await tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const access = await accessFor(c, actor, t)
    if (!access.canView) throw notFound()
    if (watch) await exec("insert into ticket_watchers (ticket_id, user_id) values ($1, $2) on conflict do nothing", [t.id, actor.id], c)
    else await exec("delete from ticket_watchers where ticket_id = $1 and user_id = $2", [t.id, actor.id], c)
  })
}

export async function deleteTicket(actor: Actor, ticketId: string): Promise<void> {
  if (!actor.permissions.has("ticket.delete")) throw forbidden()
  await tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    await exec("delete from tickets where id = $1", [t.id], c)
    await audit(
      { tenantId: t.tenant_id, actor: { id: actor.id, email: actor.email }, action: "ticket.deleted", entityType: "ticket", entityId: t.id, summary: `${t.number}: ${t.subject}`.slice(0, 300) },
      c
    )
  })
}

/* ── tasks (request fulfilment, change implementation) ─────────────────── */

export async function addTask(actor: Actor, ticketId: string, title: string, opts: { assigneeId?: string | null; groupId?: string | null } = {}, db?: Db) {
  const clean = title.trim()
  if (!clean) throw new AppError("Give the task a title")
  return run(db, async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const access = await accessFor(c, actor, t)
    if (!access.canWork && !actor.isSystem) throw forbidden()
    if (opts.assigneeId) await assertAssignable(c, t.tenant_id, opts.assigneeId)
    const order = await q1<{ n: number }>("select coalesce(max(sort_order), 0) + 1 as n from ticket_tasks where ticket_id = $1", [t.id], c)
    await exec(
      "insert into ticket_tasks (tenant_id, ticket_id, title, assignee_id, group_id, sort_order) values ($1, $2, $3, $4, $5, $6)",
      [t.tenant_id, t.id, clean.slice(0, 300), opts.assigneeId ?? null, opts.groupId ?? null, order!.n],
      c
    )
    await activity(c, t, actor, "task_added", { title: clean.slice(0, 300) })
  })
}

export async function setTaskStatus(actor: Actor, ticketId: string, taskId: string, status: "open" | "done" | "cancelled") {
  await tx(async (c) => {
    const t = await lockTicket(c, actor, ticketId)
    const access = await accessFor(c, actor, t)
    const task = await q1<{ id: string; assignee_id: string | null; title: string }>("select id, assignee_id, title from ticket_tasks where id = $1 and ticket_id = $2", [taskId, t.id], c)
    if (!task) throw notFound("Task not found")
    if (!access.canWork && task.assignee_id !== actor.id) throw forbidden()
    await exec(
      "update ticket_tasks set status = $2, completed_at = case when $2 = 'done' then now() else null end, completed_by = case when $2 = 'done' then $3::uuid else null end where id = $1",
      [taskId, status, actor.id],
      c
    )
    await activity(c, t, actor, "task_" + status, { title: task.title })
  })
}

export function typeLabel(t: TicketType) {
  return TICKET_TYPE_LABELS[t]
}
