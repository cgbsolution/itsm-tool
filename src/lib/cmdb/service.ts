/**
 * CMDB service: the only code that writes configuration items, their
 * relationships, assignments and classes. Pages, server actions, the import
 * and the endpoint agent all come through here, so tenant checks,
 * permissions and history apply everywhere.
 */
import { z } from "zod"
import { q, q1, exec, tx, isUuid, isUniqueViolation, type Db, type PoolClient } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { actorId } from "@/lib/auth/system"
import { AppError, forbidden, notFound } from "@/lib/errors"
import { parse } from "@/lib/validate"
import { audit } from "@/lib/audit"
import { DEFAULT_CI_CLASSES, type CiAttribute } from "@/lib/cmdb/classes"
import { applyAttributes, readSchema } from "@/lib/cmdb/attributes"
import { diffAttributes, diffFields, hasChanges, type Changes } from "@/lib/cmdb/diff"
import { addYears, cleanText, isIsoDate } from "@/lib/cmdb/values"
import {
  CI_CONDITIONS, CI_CRITICALITIES, CI_ENVIRONMENTS, CI_STATUSES, CLASS_CATEGORIES, REL_LABELS, isRelType,
  type CiStatus, type ClassCategory,
} from "@/lib/cmdb/vocab"

export type CiRow = {
  id: string
  tenant_id: string
  class_id: string
  ci_code: string
  name: string
  status: CiStatus
  condition: string | null
  environment: string | null
  criticality: string | null
  owner_id: string | null
  support_group_id: string | null
  organization_id: string | null
  location: string | null
  room: string | null
  department: string | null
  manufacturer: string | null
  model: string | null
  serial_no: string | null
  purchase_date: string | null
  warranty_years: number | null
  warranty_expiry: string | null
  cost: number | null
  attributes: Record<string, unknown>
  notes: string | null
  source: string
  last_seen_at: Date | null
  created_at: Date
  updated_at: Date
}

export const CI_COLUMNS = `id, tenant_id, class_id, ci_code, name, status, condition, environment, criticality, owner_id, support_group_id,
  organization_id, location, room, department, manufacturer, model, serial_no, purchase_date, warranty_years, warranty_expiry,
  cost, attributes, notes, source, last_seen_at, created_at, updated_at`

export type ClassRow = { id: string; tenant_id: string; key: string; name: string; category: ClassCategory; attributes: CiAttribute[]; is_active: boolean; created_at: Date }

/* ── helpers ───────────────────────────────────────────────────────────── */

function run<T>(db: Db | undefined, fn: (db: Db) => Promise<T>): Promise<T> {
  return db ? fn(db) : tx(fn)
}

function isClient(db: Db): db is PoolClient {
  return typeof (db as PoolClient).release === "function"
}

/** Runs `fn` atomically: inside the caller's transaction (a client), or a new one (a pool). */
async function atomically<T>(db: Db, fn: (c: Db) => Promise<T>): Promise<T> {
  if (isClient(db)) return fn(db)
  const client = await db.connect()
  try {
    await client.query("begin")
    const out = await fn(client)
    await client.query("commit")
    return out
  } catch (err) {
    await client.query("rollback").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function need(actor: Actor, perm: "cmdb.edit" | "cmdb.delete" | "admin.itsm", message: string) {
  if (!actor.permissions.has(perm)) throw forbidden(message)
}

export async function writeHistory(db: Db, tenantId: string, ciId: string, actor: Actor | null, action: string, changes: Changes | null): Promise<void> {
  await exec(
    "insert into ci_history (tenant_id, ci_id, actor_id, action, changes) values ($1, $2, $3, $4, $5)",
    [tenantId, ciId, actor ? actorId(actor) : null, action, changes && hasChanges(changes) ? JSON.stringify(changes) : null],
    db
  )
}

async function lockCi(db: Db, actor: Actor, id: string): Promise<CiRow> {
  if (!isUuid(id)) throw notFound("Configuration item not found")
  const ci = await q1<CiRow>(`select ${CI_COLUMNS} from configuration_items where id = $1 and tenant_id = $2 for update`, [id, actor.tenantId], db)
  if (!ci) throw notFound("Configuration item not found")
  return ci
}

export async function findByCode(db: Db, tenantId: string, code: string): Promise<{ id: string; ci_code: string; name: string } | null> {
  return q1("select id, ci_code, name from configuration_items where tenant_id = $1 and upper(trim(ci_code)) = upper(trim($2))", [tenantId, code], db)
}

async function assertCodeFree(db: Db, tenantId: string, code: string, exceptId?: string) {
  const other = await findByCode(db, tenantId, code)
  if (other && other.id !== exceptId) throw new AppError(`The CI code ${other.ci_code} is already used by "${other.name}"`)
}

function friendlyUnique(err: unknown, code: string): never {
  if (isUniqueViolation(err, "configuration_items_code_key")) throw new AppError(`The CI code ${code} is already in use`)
  throw err
}

async function loadClassById(db: Db, tenantId: string, classId: string): Promise<ClassRow> {
  if (!isUuid(classId)) throw new AppError("Choose a class")
  const c = await q1<ClassRow>("select * from ci_classes where id = $1 and tenant_id = $2", [classId, tenantId], db)
  if (!c) throw new AppError("That class does not exist")
  return { ...c, attributes: readSchema(c.attributes) }
}

type Refs = { class_id: string; owner_id: string | null; support_group_id: string | null; organization_id: string | null }
type RefLabels = { class: string | null; owner: string | null; support_group: string | null; organization: string | null }

/** Display labels of a CI's references (email for the owner). Also how new references are validated. */
async function refLabels(db: Db, tenantId: string, r: Refs): Promise<RefLabels> {
  const row = await q1<RefLabels>(
    `select (select name from ci_classes where id = $2 and tenant_id = $1) as class,
            (select email from users where id = $3 and tenant_id = $1) as owner,
            (select name from groups where id = $4 and tenant_id = $1) as support_group,
            (select name from organizations where id = $5 and tenant_id = $1) as organization`,
    [tenantId, r.class_id, r.owner_id, r.support_group_id, r.organization_id],
    db
  )
  return row ?? { class: null, owner: null, support_group: null, organization: null }
}

async function assertNewRefs(db: Db, tenantId: string, before: Refs | null, after: Refs): Promise<RefLabels> {
  const labels = await refLabels(db, tenantId, after)
  if (after.owner_id && after.owner_id !== before?.owner_id) {
    const u = await q1("select 1 from users where id = $1 and tenant_id = $2 and status = 'active'", [after.owner_id, tenantId], db)
    if (!u) throw new AppError("That owner is not an active user")
  }
  if (after.support_group_id && after.support_group_id !== before?.support_group_id) {
    const g = await q1("select 1 from groups where id = $1 and tenant_id = $2 and is_active", [after.support_group_id, tenantId], db)
    if (!g) throw new AppError("That support group does not exist")
  }
  if (after.organization_id && after.organization_id !== before?.organization_id && !labels.organization) throw new AppError("That organisation does not exist")
  return labels
}

const DIFF_FIELDS = [
  "ci_code", "name", "class", "status", "condition", "environment", "criticality", "owner", "support_group", "organization",
  "location", "room", "department", "manufacturer", "model", "serial_no", "purchase_date", "warranty_years", "warranty_expiry", "cost", "notes",
]

type DisplayInput = Omit<CiRow, "id" | "tenant_id" | "source" | "last_seen_at" | "created_at" | "updated_at" | "attributes">

function display(ci: DisplayInput, labels: RefLabels): Record<string, unknown> {
  return {
    ci_code: ci.ci_code, name: ci.name, class: labels.class, status: ci.status, condition: ci.condition, environment: ci.environment,
    criticality: ci.criticality, owner: labels.owner, support_group: labels.support_group, organization: labels.organization,
    location: ci.location, room: ci.room, department: ci.department, manufacturer: ci.manufacturer, model: ci.model,
    serial_no: ci.serial_no, purchase_date: ci.purchase_date, warranty_years: ci.warranty_years, warranty_expiry: ci.warranty_expiry,
    cost: ci.cost, notes: ci.notes,
  }
}

/** The field-level diff stored in ci_history (references shown by name/email). */
export function ciChanges(before: { ci: DisplayInput; labels: RefLabels; attributes: Record<string, unknown> } | null, after: { ci: DisplayInput; labels: RefLabels; attributes: Record<string, unknown> } | null): Changes {
  return {
    ...diffFields(before ? display(before.ci, before.labels) : null, after ? display(after.ci, after.labels) : null, DIFF_FIELDS),
    ...diffAttributes(before?.attributes ?? {}, after?.attributes ?? {}),
  }
}

/** Keeps ci_assignments in step with owner_id: at most one open assignment, for the owner. */
export async function syncAssignment(db: Db, ci: { id: string; tenant_id: string }, ownerId: string | null, actor: Actor | null, note?: string | null): Promise<void> {
  const open = await q1<{ id: string; user_id: string }>(
    "select id, user_id from ci_assignments where ci_id = $1 and tenant_id = $2 and returned_at is null for update",
    [ci.id, ci.tenant_id],
    db
  )
  if (open && open.user_id === ownerId) return
  if (open) await exec("update ci_assignments set returned_at = now() where id = $1 and tenant_id = $2", [open.id, ci.tenant_id], db)
  if (ownerId) {
    await exec(
      "insert into ci_assignments (tenant_id, ci_id, user_id, assigned_by, note) values ($1, $2, $3, $4, $5)",
      [ci.tenant_id, ci.id, ownerId, actor ? actorId(actor) : null, note ?? null],
      db
    )
  }
}

/* ── create / update ───────────────────────────────────────────────────── */

const optText = (max: number, label: string) => z.string().max(max, `${label} must be at most ${max} characters`).nullish()
const ref = z.string().refine((v) => isUuid(v), "Invalid reference").nullish()
const isoDate = (label: string) => z.string().refine((v) => isIsoDate(v), `${label} must be a date (YYYY-MM-DD)`).nullish()

export const ciInputSchema = z.object({
  classId: z.string().refine((v) => isUuid(v), "Choose a class"),
  ciCode: z
    .string()
    .trim()
    .min(1, "Enter a CI code")
    .max(64, "Keep the CI code to 64 characters")
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "The CI code contains invalid characters"),
  name: z.string().trim().min(1, "Enter a name").max(200, "Keep the name under 200 characters"),
  status: z.enum(CI_STATUSES).optional(),
  condition: z.enum(CI_CONDITIONS).nullish(),
  environment: z.enum(CI_ENVIRONMENTS).nullish(),
  criticality: z.enum(CI_CRITICALITIES).nullish(),
  ownerId: ref,
  supportGroupId: ref,
  organizationId: ref,
  location: optText(200, "Location"),
  room: optText(100, "Room"),
  department: optText(200, "Department"),
  manufacturer: optText(200, "Manufacturer"),
  model: optText(200, "Model"),
  serialNo: optText(120, "Serial number"),
  purchaseDate: isoDate("Purchase date"),
  warrantyYears: z.number().int("Warranty years must be a whole number").min(0).max(50, "Warranty years must be 50 or less").nullish(),
  warrantyExpiry: isoDate("Warranty expiry"),
  cost: z.number().min(0, "Cost cannot be negative").max(1e12, "Cost is too large").nullish(),
  notes: optText(10_000, "Notes"),
  attributes: z.record(z.string(), z.unknown()).optional(),
})
export type CiInput = z.input<typeof ciInputSchema>
export const ciUpdateSchema = ciInputSchema.partial()
export type CiUpdateInput = z.input<typeof ciUpdateSchema>

const INPUT_COLUMNS: Record<string, keyof CiRow> = {
  ciCode: "ci_code", name: "name", status: "status", condition: "condition", environment: "environment", criticality: "criticality",
  ownerId: "owner_id", supportGroupId: "support_group_id", organizationId: "organization_id", location: "location", room: "room",
  department: "department", manufacturer: "manufacturer", model: "model", serialNo: "serial_no", purchaseDate: "purchase_date",
  warrantyYears: "warranty_years", warrantyExpiry: "warranty_expiry", cost: "cost", notes: "notes", classId: "class_id",
}

/** Blank strings are stored as null. */
function nz<T>(v: T | null | undefined): T | null {
  if (v === undefined || v === null) return null
  if (typeof v === "string" && v.trim() === "") return null
  return v
}

function withWarranty<T extends { purchase_date: string | null; warranty_years: number | null; warranty_expiry: string | null }>(r: T): T {
  if (!r.warranty_expiry && r.purchase_date && r.warranty_years !== null && r.warranty_years !== undefined) {
    return { ...r, warranty_expiry: addYears(r.purchase_date, r.warranty_years) }
  }
  return r
}

export async function createCi(actor: Actor, raw: CiInput, db?: Db, opts: { source?: "manual" | "api" } = {}): Promise<CiRow> {
  need(actor, "cmdb.edit", "You cannot create configuration items")
  const input = parse(ciInputSchema, raw)
  return run(db, async (c) => {
    const cls = await loadClassById(c, actor.tenantId, input.classId)
    if (!cls.is_active) throw new AppError(`The class ${cls.name} is no longer in use`)
    const attrs = applyAttributes(cls.attributes, {}, input.attributes ?? {}, "form")
    if (attrs.errors.length) throw new AppError(attrs.errors.join("; "))
    await assertCodeFree(c, actor.tenantId, input.ciCode)
    const values = withWarranty({
      class_id: cls.id, ci_code: input.ciCode, name: input.name, status: input.status ?? "in_use",
      condition: nz(input.condition), environment: nz(input.environment), criticality: nz(input.criticality),
      owner_id: nz(input.ownerId), support_group_id: nz(input.supportGroupId), organization_id: nz(input.organizationId),
      location: nz(input.location), room: nz(input.room), department: nz(input.department),
      manufacturer: nz(input.manufacturer), model: nz(input.model), serial_no: nz(input.serialNo),
      purchase_date: nz(input.purchaseDate), warranty_years: nz(input.warrantyYears), warranty_expiry: nz(input.warrantyExpiry),
      cost: nz(input.cost), notes: nz(input.notes),
    })
    const labels = await assertNewRefs(c, actor.tenantId, null, values)
    let row: CiRow | null
    try {
      row = await q1<CiRow>(
        `insert into configuration_items (tenant_id, class_id, ci_code, name, status, condition, environment, criticality, owner_id,
           support_group_id, organization_id, location, room, department, manufacturer, model, serial_no, purchase_date,
           warranty_years, warranty_expiry, cost, attributes, notes, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         returning ${CI_COLUMNS}`,
        [
          actor.tenantId, values.class_id, values.ci_code, values.name, values.status, values.condition, values.environment, values.criticality,
          values.owner_id, values.support_group_id, values.organization_id, values.location, values.room, values.department,
          values.manufacturer, values.model, values.serial_no, values.purchase_date, values.warranty_years, values.warranty_expiry,
          values.cost, JSON.stringify(attrs.attributes), values.notes, opts.source ?? "manual",
        ],
        c
      )
    } catch (e) {
      friendlyUnique(e, values.ci_code)
    }
    const ci = row!
    if (ci.owner_id) await syncAssignment(c, ci, ci.owner_id, actor, "Owner set when the item was created")
    await writeHistory(c, ci.tenant_id, ci.id, actor, "created", ciChanges(null, { ci, labels, attributes: ci.attributes }))
    return ci
  })
}

export async function updateCi(actor: Actor, ciId: string, raw: CiUpdateInput, db?: Db): Promise<CiRow> {
  need(actor, "cmdb.edit", "You cannot edit configuration items")
  const input = parse(ciUpdateSchema, raw)
  return run(db, async (c) => {
    const before = await lockCi(c, actor, ciId)
    const classChanged = !!input.classId && input.classId !== before.class_id
    const cls = await loadClassById(c, actor.tenantId, input.classId ?? before.class_id)
    if (classChanged && !cls.is_active) throw new AppError(`The class ${cls.name} is no longer in use`)

    const next = { ...before } as CiRow
    for (const [key, col] of Object.entries(INPUT_COLUMNS)) {
      const v = (input as Record<string, unknown>)[key]
      if (v === undefined) continue
      ;(next as Record<string, unknown>)[col] = nz(v)
    }
    if (!next.status) next.status = before.status
    const withW = withWarranty(next)
    const attrs = applyAttributes(cls.attributes, before.attributes, input.attributes ?? {}, input.attributes ? "form" : "merge")
    if (attrs.errors.length) throw new AppError(attrs.errors.join("; "))
    withW.attributes = attrs.attributes

    if (withW.ci_code.trim().toUpperCase() !== before.ci_code.trim().toUpperCase()) await assertCodeFree(c, actor.tenantId, withW.ci_code, before.id)
    const [beforeLabels, afterLabels] = [await refLabels(c, actor.tenantId, before), await assertNewRefs(c, actor.tenantId, before, withW)]
    const changes = ciChanges({ ci: before, labels: beforeLabels, attributes: before.attributes }, { ci: withW, labels: afterLabels, attributes: withW.attributes })
    if (!hasChanges(changes)) return before

    const cols = [...new Set(Object.values(INPUT_COLUMNS))].filter((col) => col !== "attributes")
    try {
      await exec(
        `update configuration_items set ${cols.map((col, i) => `${col} = $${i + 3}`).join(", ")}, attributes = $${cols.length + 3}, updated_at = now()
          where id = $1 and tenant_id = $2`,
        [before.id, before.tenant_id, ...cols.map((col) => (withW as Record<string, unknown>)[col]), JSON.stringify(withW.attributes)],
        c
      )
    } catch (e) {
      friendlyUnique(e, withW.ci_code)
    }
    if (withW.owner_id !== before.owner_id) await syncAssignment(c, before, withW.owner_id, actor, "Owner changed on the item")
    await writeHistory(c, before.tenant_id, before.id, actor, "updated", changes)
    return (await q1<CiRow>(`select ${CI_COLUMNS} from configuration_items where id = $1 and tenant_id = $2`, [before.id, before.tenant_id], c))!
  })
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

export async function retireCi(actor: Actor, ciId: string): Promise<void> {
  need(actor, "cmdb.edit", "You cannot retire configuration items")
  await tx(async (c) => {
    const ci = await lockCi(c, actor, ciId)
    if (ci.status === "retired" || ci.status === "disposed") throw new AppError("This item is already retired")
    const labels = await refLabels(c, ci.tenant_id, ci)
    await exec("update configuration_items set status = 'retired', owner_id = null, updated_at = now() where id = $1 and tenant_id = $2", [ci.id, ci.tenant_id], c)
    await syncAssignment(c, ci, null, actor)
    const after = { ...ci, status: "retired" as const, owner_id: null }
    await writeHistory(c, ci.tenant_id, ci.id, actor, "retired", ciChanges({ ci, labels, attributes: ci.attributes }, { ci: after, labels: { ...labels, owner: null }, attributes: ci.attributes }))
  })
}

export async function deleteCi(actor: Actor, ciId: string): Promise<{ ci_code: string }> {
  need(actor, "cmdb.delete", "You cannot delete configuration items")
  return tx(async (c) => {
    const ci = await lockCi(c, actor, ciId)
    const labels = await refLabels(c, ci.tenant_id, ci)
    const rels = await q<{ source_id: string; target_id: string; rel_type: string }>(
      "select source_id, target_id, rel_type from ci_relationships where tenant_id = $1 and (source_id = $2 or target_id = $2)",
      [ci.tenant_id, ci.id],
      c
    )
    for (const r of rels) {
      if (!isRelType(r.rel_type)) continue
      const outgoing = r.source_id === ci.id
      const other = outgoing ? r.target_id : r.source_id
      const label = outgoing ? REL_LABELS[r.rel_type].in : REL_LABELS[r.rel_type].out
      await writeHistory(c, ci.tenant_id, other, actor, "relationship_removed", { relationship: { from: `${label} ${ci.ci_code} (deleted)`, to: null } })
    }
    // the history row outlives the item (0005 drops the foreign key)
    await writeHistory(c, ci.tenant_id, ci.id, actor, "deleted", ciChanges({ ci, labels, attributes: ci.attributes }, null))
    await exec("delete from configuration_items where id = $1 and tenant_id = $2", [ci.id, ci.tenant_id], c)
    await audit(
      {
        tenantId: ci.tenant_id,
        actor: { id: actor.id, email: actor.email },
        action: "cmdb.ci_deleted",
        entityType: "ci",
        entityId: ci.id,
        summary: `${ci.ci_code}: ${ci.name}`.slice(0, 300),
        data: { ci_code: ci.ci_code, name: ci.name, class: labels.class, serial_no: ci.serial_no, relationships: rels.length },
      },
      c
    )
    return { ci_code: ci.ci_code }
  })
}

/* ── relationships ─────────────────────────────────────────────────────── */

export async function addRelationship(actor: Actor, ciId: string, targetCode: string, relType: string): Promise<void> {
  need(actor, "cmdb.edit", "You cannot change relationships")
  if (!isRelType(relType)) throw new AppError("Choose a relationship type")
  const code = targetCode.trim()
  if (!code) throw new AppError("Enter the code of the other configuration item")
  await tx(async (c) => {
    const ci = await lockCi(c, actor, ciId)
    const target = await findByCode(c, ci.tenant_id, code)
    if (!target) throw new AppError(`No configuration item has the code ${code.slice(0, 64)}`)
    if (target.id === ci.id) throw new AppError("An item cannot be related to itself")
    const row = await q1<{ id: string }>(
      `insert into ci_relationships (tenant_id, source_id, target_id, rel_type, created_by) values ($1, $2, $3, $4, $5)
       on conflict (source_id, target_id, rel_type) do nothing returning id`,
      [ci.tenant_id, ci.id, target.id, relType, actorId(actor)],
      c
    )
    if (!row) throw new AppError("That relationship already exists")
    await writeHistory(c, ci.tenant_id, ci.id, actor, "relationship_added", { relationship: { from: null, to: `${REL_LABELS[relType].out} ${target.ci_code}` } })
    await writeHistory(c, ci.tenant_id, target.id, actor, "relationship_added", { relationship: { from: null, to: `${REL_LABELS[relType].in} ${ci.ci_code}` } })
  })
}

export async function removeRelationship(actor: Actor, ciId: string, relationshipId: string): Promise<void> {
  need(actor, "cmdb.edit", "You cannot change relationships")
  if (!isUuid(relationshipId)) throw notFound("Relationship not found")
  await tx(async (c) => {
    const ci = await lockCi(c, actor, ciId)
    const r = await q1<{ source_id: string; target_id: string; rel_type: string; source_code: string; target_code: string }>(
      `delete from ci_relationships r using configuration_items s, configuration_items t
        where r.id = $1 and r.tenant_id = $2 and (r.source_id = $3 or r.target_id = $3) and s.id = r.source_id and t.id = r.target_id
        returning r.source_id, r.target_id, r.rel_type, s.ci_code as source_code, t.ci_code as target_code`,
      [relationshipId, ci.tenant_id, ci.id],
      c
    )
    if (!r || !isRelType(r.rel_type)) throw notFound("Relationship not found")
    await writeHistory(c, ci.tenant_id, r.source_id, actor, "relationship_removed", { relationship: { from: `${REL_LABELS[r.rel_type].out} ${r.target_code}`, to: null } })
    await writeHistory(c, ci.tenant_id, r.target_id, actor, "relationship_removed", { relationship: { from: `${REL_LABELS[r.rel_type].in} ${r.source_code}`, to: null } })
  })
}

/* ── assignment ────────────────────────────────────────────────────────── */

export async function assignCi(actor: Actor, ciId: string, userId: string, note?: string | null): Promise<void> {
  need(actor, "cmdb.edit", "You cannot assign configuration items")
  if (!isUuid(userId)) throw new AppError("Choose a person")
  await tx(async (c) => {
    const ci = await lockCi(c, actor, ciId)
    if (ci.status === "retired" || ci.status === "disposed") throw new AppError("Retired items cannot be assigned")
    const user = await q1<{ id: string; email: string }>("select id, email from users where id = $1 and tenant_id = $2 and status = 'active'", [userId, ci.tenant_id], c)
    if (!user) throw new AppError("That person is not an active user")
    const open = await q1<{ user_id: string }>("select user_id from ci_assignments where ci_id = $1 and tenant_id = $2 and returned_at is null", [ci.id, ci.tenant_id], c)
    if (open?.user_id === user.id && ci.owner_id === user.id) throw new AppError(`It is already assigned to ${user.email}`)
    const labels = await refLabels(c, ci.tenant_id, ci)
    const status: CiStatus = ci.status === "in_stock" || ci.status === "planned" ? "in_use" : ci.status
    await exec("update configuration_items set owner_id = $3, status = $4, updated_at = now() where id = $1 and tenant_id = $2", [ci.id, ci.tenant_id, user.id, status], c)
    try {
      await syncAssignment(c, ci, user.id, actor, cleanText(note, 1000))
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("Someone else assigned this item at the same time. Reload and try again.")
      throw e
    }
    const changes = ciChanges(
      { ci, labels, attributes: ci.attributes },
      { ci: { ...ci, owner_id: user.id, status }, labels: { ...labels, owner: user.email }, attributes: ci.attributes }
    )
    if (note?.trim()) changes.assignment = { from: null, to: cleanText(note, 1000) }
    await writeHistory(c, ci.tenant_id, ci.id, actor, "assigned", changes)
  })
}

export async function returnCi(actor: Actor, ciId: string, note?: string | null): Promise<void> {
  need(actor, "cmdb.edit", "You cannot change assignments")
  await tx(async (c) => {
    const ci = await lockCi(c, actor, ciId)
    const open = await q1<{ id: string }>("select id from ci_assignments where ci_id = $1 and tenant_id = $2 and returned_at is null", [ci.id, ci.tenant_id], c)
    if (!open && !ci.owner_id) throw new AppError("This item is not assigned to anyone")
    const labels = await refLabels(c, ci.tenant_id, ci)
    const status: CiStatus = ci.status === "in_use" ? "in_stock" : ci.status
    await exec("update configuration_items set owner_id = null, status = $3, updated_at = now() where id = $1 and tenant_id = $2", [ci.id, ci.tenant_id, status], c)
    if (open && note?.trim()) {
      await exec("update ci_assignments set note = concat_ws(' · ', note, $3::text) where id = $1 and tenant_id = $2", [open.id, ci.tenant_id, cleanText(note, 1000)], c)
    }
    await syncAssignment(c, ci, null, actor)
    await writeHistory(
      c, ci.tenant_id, ci.id, actor, "returned",
      ciChanges({ ci, labels, attributes: ci.attributes }, { ci: { ...ci, owner_id: null, status }, labels: { ...labels, owner: null }, attributes: ci.attributes })
    )
  })
}

/* ── classes ───────────────────────────────────────────────────────────── */

export type ClassInput = { key?: string; name: string; category: string; attributes: CiAttribute[]; isActive?: boolean }

function checkClassInput(input: ClassInput) {
  const name = cleanText(input.name, 120)
  if (!name) throw new AppError("Give the class a name")
  if (!(CLASS_CATEGORIES as readonly string[]).includes(input.category)) throw new AppError("Choose a category")
  return { name, category: input.category as ClassCategory }
}

export async function createClass(actor: Actor, input: ClassInput): Promise<ClassRow> {
  need(actor, "admin.itsm", "Only administrators can manage CI classes")
  const { name, category } = checkClassInput(input)
  const key = String(input.key ?? "").trim()
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) throw new AppError("The key must start with a lower-case letter and use only a-z, 0-9 and _ (up to 41 characters)")
  return tx(async (c) => {
    let row: ClassRow | null
    try {
      row = await q1<ClassRow>(
        "insert into ci_classes (tenant_id, key, name, category, attributes) values ($1, $2, $3, $4, $5) returning *",
        [actor.tenantId, key, name, category, JSON.stringify(input.attributes)],
        c
      )
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(`A class with the key ${key} already exists`)
      throw e
    }
    await audit(
      { tenantId: actor.tenantId, actor: { id: actor.id, email: actor.email }, action: "cmdb.class_created", entityType: "ci_class", entityId: row!.id, summary: `${name} (${key})`, data: { attributes: input.attributes.length } },
      c
    )
    return row!
  })
}

export async function updateClass(actor: Actor, classId: string, input: ClassInput): Promise<void> {
  need(actor, "admin.itsm", "Only administrators can manage CI classes")
  const { name, category } = checkClassInput(input)
  await tx(async (c) => {
    if (!isUuid(classId)) throw notFound("Class not found")
    const before = await q1<ClassRow>("select * from ci_classes where id = $1 and tenant_id = $2 for update", [classId, actor.tenantId], c)
    if (!before) throw notFound("Class not found")
    const isActive = input.isActive ?? before.is_active
    await exec("update ci_classes set name = $3, category = $4, attributes = $5, is_active = $6 where id = $1 and tenant_id = $2", [classId, actor.tenantId, name, category, JSON.stringify(input.attributes), isActive], c)
    const changes = {
      ...diffFields({ name: before.name, category: before.category, is_active: before.is_active }, { name, category, is_active: isActive }),
      ...(JSON.stringify(readSchema(before.attributes)) !== JSON.stringify(input.attributes) ? { attributes: { from: readSchema(before.attributes).map((a) => a.key), to: input.attributes.map((a) => a.key) } } : {}),
    }
    if (hasChanges(changes)) {
      await audit(
        { tenantId: actor.tenantId, actor: { id: actor.id, email: actor.email }, action: "cmdb.class_updated", entityType: "ci_class", entityId: classId, summary: `${name} (${before.key})`, data: { changes } },
        c
      )
    }
  })
}

export async function deleteClass(actor: Actor, classId: string): Promise<void> {
  need(actor, "admin.itsm", "Only administrators can manage CI classes")
  await tx(async (c) => {
    if (!isUuid(classId)) throw notFound("Class not found")
    const cls = await q1<ClassRow>("select * from ci_classes where id = $1 and tenant_id = $2 for update", [classId, actor.tenantId], c)
    if (!cls) throw notFound("Class not found")
    const used = await q1<{ n: number }>("select count(*) as n from configuration_items where tenant_id = $1 and class_id = $2", [actor.tenantId, classId], c)
    if (used!.n > 0) throw new AppError(`${used!.n} configuration item${used!.n === 1 ? " uses" : "s use"} this class. Deactivate it instead.`)
    await exec("delete from ci_classes where id = $1 and tenant_id = $2", [classId, actor.tenantId], c)
    await audit({ tenantId: actor.tenantId, actor: { id: actor.id, email: actor.email }, action: "cmdb.class_deleted", entityType: "ci_class", entityId: classId, summary: `${cls.name} (${cls.key})` }, c)
  })
}

/* ── endpoint agent inventory ──────────────────────────────────────────── */

export type DeviceInventory = {
  hostname: string
  os_family?: string | null
  os_name?: string | null
  manufacturer?: string | null
  model?: string | null
  serial_no?: string | null
  cpu?: string | null
  ram_mb?: number | null
  mac_addresses?: string[] | null
  ip_addresses?: string[] | null
}

const JUNK_SERIAL = /^(to be filled( by o\.?e\.?m\.?)?|default string|system serial number|chassis serial number|serial number|not specified|not applicable|none|null|unknown|n\/?a|o\.?e\.?m\.?|123456789|1234567890|0123456789)$/i

/** A serial number worth matching on (placeholders such as "To be filled by O.E.M." are not). */
export function usableSerial(raw: string | null | undefined): string | null {
  const s = cleanText(raw, 120)
  if (!s || s.length < 3 || JUNK_SERIAL.test(s) || /^(.)\1*$/.test(s)) return null
  return s
}

const LAPTOP_MODEL = /laptop|notebook|macbook|thinkpad|latitude|elitebook|probook|zbook|ideapad|yoga|vivobook|zenbook|surface (laptop|book|pro|go)|chromebook|travelmate|spectre|dynabook|portege|tecra|xps 1[3-7]|inspiron 1[3-7]|precision 7[5-7]\d0|precision 5[5-7]\d0|galaxy book|matebook|thinkbook|aspire [1-7] /i
const DESKTOP_MODEL = /desktop|optiplex|thinkcentre|prodesk|elitedesk|imac|mac ?mini|mac pro|mac studio|tower|all-in-one|\baio\b|veriton|workstation|vostro 3[6-9]\d0|precision 3[4-9]\d0|precision [57]8\d0|\bz[248] g\d/i

/** Class key for an agent-reported device: server by OS name, else laptop/desktop by model. */
export function classKeyForDevice(d: Pick<DeviceInventory, "os_name" | "model">): "server" | "laptop" | "desktop" {
  if (/server/i.test(d.os_name ?? "")) return "server"
  const model = d.model ?? ""
  if (LAPTOP_MODEL.test(model)) return "laptop"
  if (DESKTOP_MODEL.test(model)) return "desktop"
  return "desktop"
}

/** Attribute values the agent knows about a device. */
export function deviceAttributes(d: DeviceInventory): Record<string, string> {
  const out: Record<string, string> = {}
  const host = cleanText(d.hostname, 255)
  if (host) out.hostname = host
  const cpu = cleanText(d.cpu, 300)
  if (cpu) out.cpu = cpu
  if (typeof d.ram_mb === "number" && d.ram_mb > 0) out.ram = d.ram_mb >= 1024 ? `${Math.round(d.ram_mb / 1024)} GB` : `${Math.round(d.ram_mb)} MB`
  const os = cleanText(d.os_name, 200)
  if (os) out.os_name = os
  const macs = (d.mac_addresses ?? []).map((m) => cleanText(m, 40)?.toUpperCase()).filter((m): m is string => !!m && !/^(00[:-]){5}00$/.test(m))
  if (macs.length) out.mac_address = [...new Set(macs)].join(", ").slice(0, 500)
  const ips = (d.ip_addresses ?? []).map((ip) => cleanText(ip, 64)).filter((ip): ip is string => !!ip && !/^(127\.|::1$|fe80:|169\.254\.)/i.test(ip))
  if (ips.length) out.ip_address = [...new Set(ips)].join(", ").slice(0, 500)
  return out
}

async function classIdForKey(db: Db, tenantId: string, key: string): Promise<string> {
  for (const k of [key, "desktop", "other"]) {
    const row = await q1<{ id: string }>("select id from ci_classes where tenant_id = $1 and key = $2", [tenantId, k], db)
    if (row) return row.id
    const def = DEFAULT_CI_CLASSES.find((c) => c.key === k)
    if (def) {
      const made = await q1<{ id: string }>(
        `insert into ci_classes (tenant_id, key, name, category, attributes) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, key) do update set key = excluded.key returning id`,
        [tenantId, def.key, def.name, def.category, JSON.stringify(def.attributes)],
        db
      )
      if (made) return made.id
    }
  }
  throw new AppError("The tenant has no CI classes")
}

/**
 * Finds the CI for an agent-reported device, or creates it. Matches on the
 * serial number first, then on CI code = upper(hostname). Sets source='agent'
 * and last_seen_at, fills manufacturer/model/serial and merges the cpu, ram,
 * os_name, hostname, mac_address and ip_address attributes. History is only
 * written when something other than last_seen_at changed.
 *
 * Pass a transaction client to join the caller's transaction; with a pool it
 * runs in its own transaction. Returns the CI id.
 */
export async function findOrCreateCiForDevice(db: Db, tenantId: string, device: DeviceInventory): Promise<string> {
  if (!isUuid(tenantId)) throw new AppError("Invalid tenant")
  const hostname = cleanText(device.hostname, 64)
  if (!hostname) throw new AppError("The device has no host name")
  const code = hostname.toUpperCase()
  const serial = usableSerial(device.serial_no)
  const facts = deviceAttributes(device)
  const manufacturer = cleanText(device.manufacturer, 200)
  const model = cleanText(device.model, 200)

  return atomically(db, async (c) => {
    let ci = serial
      ? await q1<CiRow>(
          `select ${CI_COLUMNS} from configuration_items where tenant_id = $1 and upper(trim(serial_no)) = upper($2)
            order by (source = 'agent') desc, updated_at desc limit 1 for update`,
          [tenantId, serial],
          c
        )
      : null
    if (!ci) ci = await q1<CiRow>(`select ${CI_COLUMNS} from configuration_items where tenant_id = $1 and upper(trim(ci_code)) = $2 for update`, [tenantId, code], c)

    if (!ci) {
      const classId = await classIdForKey(c, tenantId, classKeyForDevice(device))
      const created = await q1<CiRow>(
        `insert into configuration_items (tenant_id, class_id, ci_code, name, status, manufacturer, model, serial_no, attributes, source, last_seen_at)
         values ($1, $2, $3, $4, 'in_use', $5, $6, $7, $8, 'agent', now())
         on conflict do nothing
         returning ${CI_COLUMNS}`,
        [tenantId, classId, code, hostname, manufacturer, model, serial, JSON.stringify(facts)],
        c
      )
      if (created) {
        const labels = await refLabels(c, tenantId, created)
        await writeHistory(c, tenantId, created.id, null, "agent_created", ciChanges(null, { ci: created, labels, attributes: created.attributes }))
        return created.id
      }
      // created by a concurrent report: update that one
      ci = await q1<CiRow>(`select ${CI_COLUMNS} from configuration_items where tenant_id = $1 and upper(trim(ci_code)) = $2 for update`, [tenantId, code], c)
      if (!ci) throw new AppError("Could not create the configuration item for this device")
    }

    const next = {
      ...ci,
      manufacturer: manufacturer ?? ci.manufacturer,
      model: model ?? ci.model,
      serial_no: serial ?? ci.serial_no,
      attributes: { ...ci.attributes, ...facts },
    }
    const labels = await refLabels(c, tenantId, ci)
    const changes = ciChanges({ ci, labels, attributes: ci.attributes }, { ci: next, labels, attributes: next.attributes })
    if (ci.source !== "agent") changes.source = { from: ci.source, to: "agent" }
    await exec(
      `update configuration_items set manufacturer = $3, model = $4, serial_no = $5, attributes = $6, source = 'agent', last_seen_at = now()
              ${hasChanges(changes) ? ", updated_at = now()" : ""}
        where id = $1 and tenant_id = $2`,
      [ci.id, tenantId, next.manufacturer, next.model, next.serial_no, JSON.stringify(next.attributes)],
      c
    )
    if (hasChanges(changes)) await writeHistory(c, tenantId, ci.id, null, "agent_updated", changes)
    return ci.id
  })
}
