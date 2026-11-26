/**
 * Groups (support / assignment groups, CAB, approver groups) and their members.
 * Requires admin.users. A group still used by open work cannot be deleted;
 * deactivate it instead.
 */
import { q, q1, exec, tx, isUuid, isUniqueViolation, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { bool } from "@/lib/validate"
import { STATE_CATEGORY, STATUSES } from "@/lib/itsm/workflow"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { optionalEmail, optionalText, requiredText } from "@/lib/admin/rules"

export const GROUP_KINDS = ["support", "cab", "approvers", "other"] as const
export type GroupKind = (typeof GROUP_KINDS)[number]
export const GROUP_KIND_LABELS: Record<GroupKind, string> = {
  support: "Support / assignment",
  cab: "Change Advisory Board",
  approvers: "Approvers",
  other: "Other",
}

/** Statuses that still count as open work (resolved tickets can be reopened). */
export const OPEN_STATUSES = STATUSES.filter((s) => STATE_CATEGORY[s] !== "done")

export type GroupRow = {
  id: string
  name: string
  description: string | null
  email: string | null
  kind: GroupKind
  manager_id: string | null
  manager_name: string | null
  is_active: boolean
  member_count: number
  open_tickets: number
  created_at: Date
}

const GROUP_SELECT = `
  select g.id, g.name, g.description, g.email, g.kind, g.manager_id, m.full_name as manager_name, g.is_active, g.created_at,
         (select count(*) from group_members gm where gm.group_id = g.id) as member_count,
         (select count(*) from tickets t where t.tenant_id = g.tenant_id and (t.assignment_group_id = g.id or t.cab_group_id = g.id)
             and t.status = any($2::text[])) as open_tickets
    from groups g left join users m on m.id = g.manager_id`

export async function listGroups(actor: Actor): Promise<GroupRow[]> {
  assertPermission(actor, "admin.users")
  return q<GroupRow>(`${GROUP_SELECT} where g.tenant_id = $1 order by g.is_active desc, lower(g.name)`, [actor.tenantId, OPEN_STATUSES])
}

export async function getGroup(actor: Actor, groupId: string) {
  assertPermission(actor, "admin.users")
  if (!isUuid(groupId)) throw notFound("Group not found")
  const group = await q1<GroupRow>(`${GROUP_SELECT} where g.tenant_id = $1 and g.id = $3`, [actor.tenantId, OPEN_STATUSES, groupId])
  if (!group) throw notFound("Group not found")
  const members = await q<{ id: string; full_name: string; email: string; role: string; status: string; added_at: Date }>(
    `select u.id, u.full_name, u.email, u.role, u.status, gm.added_at
       from group_members gm join users u on u.id = gm.user_id
      where gm.group_id = $1 and u.tenant_id = $2
      order by lower(coalesce(nullif(u.full_name, ''), u.email))`,
    [groupId, actor.tenantId]
  )
  return { group, members }
}

export type GroupInput = { name: unknown; description?: unknown; email?: unknown; kind?: unknown; managerId?: unknown; isActive?: unknown }

async function parseGroup(db: Db, tenantId: string, input: GroupInput) {
  const kind = String(input.kind ?? "support")
  if (!(GROUP_KINDS as readonly string[]).includes(kind)) throw new AppError("Choose what the group is for")
  const managerRaw = String(input.managerId ?? "").trim()
  let managerId: string | null = null
  if (managerRaw) {
    if (!isUuid(managerRaw) || !(await q1("select 1 from users where id = $1 and tenant_id = $2", [managerRaw, tenantId], db))) {
      throw new AppError("Manager: choose someone from the list")
    }
    managerId = managerRaw
  }
  return {
    name: requiredText(input.name, 120, "Name"),
    description: optionalText(input.description, 1000, "Description"),
    email: optionalEmail(input.email, "Group email"),
    kind: kind as GroupKind,
    manager_id: managerId,
    is_active: input.isActive === undefined ? true : bool(input.isActive),
  }
}

function friendly(e: unknown): never {
  if (isUniqueViolation(e, "groups_tenant_name_key")) throw new AppError("A group with that name already exists")
  throw e
}

export async function createGroup(actor: Actor, input: GroupInput): Promise<string> {
  assertPermission(actor, "admin.users")
  try {
    return await tx(async (db) => {
      const g = await parseGroup(db, actor.tenantId, input)
      const row = await q1<{ id: string }>(
        "insert into groups (tenant_id, name, description, email, kind, manager_id, is_active) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [actor.tenantId, g.name, g.description, g.email, g.kind, g.manager_id, g.is_active],
        db
      )
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.group_created", entityType: "group", entityId: row!.id, summary: `Group ${g.name} created`, data: { name: g.name, kind: g.kind } },
        db
      )
      return row!.id
    })
  } catch (e) {
    friendly(e)
  }
}

export async function updateGroup(actor: Actor, groupId: string, input: GroupInput): Promise<void> {
  assertPermission(actor, "admin.users")
  if (!isUuid(groupId)) throw notFound("Group not found")
  try {
    await tx(async (db) => {
      const before = await q1<{ name: string; description: string | null; email: string | null; kind: string; manager_id: string | null; is_active: boolean }>(
        "select name, description, email, kind, manager_id, is_active from groups where id = $1 and tenant_id = $2 for update",
        [groupId, actor.tenantId],
        db
      )
      if (!before) throw notFound("Group not found")
      const g = await parseGroup(db, actor.tenantId, input)
      const changed = (Object.keys(g) as (keyof typeof g)[]).filter((k) => (before[k] ?? null) !== (g[k] ?? null))
      if (!changed.length) return
      await exec(
        "update groups set name = $3, description = $4, email = $5, kind = $6, manager_id = $7, is_active = $8 where id = $1 and tenant_id = $2",
        [groupId, actor.tenantId, g.name, g.description, g.email, g.kind, g.manager_id, g.is_active],
        db
      )
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: changed.includes("is_active") ? (g.is_active ? "admin.group_activated" : "admin.group_deactivated") : "admin.group_updated",
          entityType: "group",
          entityId: groupId,
          summary: `Group ${g.name} changed: ${changed.join(", ")}`,
          data: { fields: changed, ...(changed.includes("name") ? { name: { from: before.name, to: g.name } } : {}) },
        },
        db
      )
    })
  } catch (e) {
    friendly(e)
  }
}

/** Deletes a group that no open ticket or pending approval uses. OLA policies of the group go with it. */
export async function deleteGroup(actor: Actor, groupId: string): Promise<void> {
  assertPermission(actor, "admin.users")
  if (!isUuid(groupId)) throw notFound("Group not found")
  await tx(async (db) => {
    const g = await q1<{ name: string }>("select name from groups where id = $1 and tenant_id = $2 for update", [groupId, actor.tenantId], db)
    if (!g) throw notFound("Group not found")
    const open = await q1<{ n: number }>(
      `select count(*) as n from tickets where tenant_id = $1 and (assignment_group_id = $2 or cab_group_id = $2) and status = any($3::text[])`,
      [actor.tenantId, groupId, OPEN_STATUSES],
      db
    )
    if (open!.n > 0) throw new AppError(`${open!.n} open ticket${open!.n === 1 ? " uses" : "s use"} this group. Deactivate the group instead.`)
    const pending = await q1<{ n: number }>("select count(*) as n from approvals where tenant_id = $1 and group_id = $2 and status = 'pending'", [actor.tenantId, groupId], db)
    if (pending!.n > 0) throw new AppError(`${pending!.n} pending approval${pending!.n === 1 ? " waits" : "s wait"} on this group. Deactivate the group instead.`)
    const members = await q1<{ n: number }>("select count(*) as n from group_members where group_id = $1", [groupId], db)
    const olas = await q1<{ n: number }>("select count(*) as n from sla_policies where tenant_id = $1 and group_id = $2", [actor.tenantId, groupId], db)
    await exec("delete from groups where id = $1 and tenant_id = $2", [groupId, actor.tenantId], db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.group_deleted",
        entityType: "group",
        entityId: groupId,
        summary: `Group ${g.name} deleted`,
        data: { name: g.name, members: members!.n, ola_policies_deleted: olas!.n },
      },
      db
    )
  })
}

export async function addGroupMember(actor: Actor, groupId: string, userId: string): Promise<boolean> {
  assertPermission(actor, "admin.users")
  if (!isUuid(groupId)) throw notFound("Group not found")
  if (!isUuid(userId)) throw new AppError("Choose someone to add")
  return tx(async (db) => {
    const g = await q1<{ name: string }>("select name from groups where id = $1 and tenant_id = $2", [groupId, actor.tenantId], db)
    if (!g) throw notFound("Group not found")
    const u = await q1<{ email: string }>("select email from users where id = $1 and tenant_id = $2", [userId, actor.tenantId], db)
    if (!u) throw new AppError("That person is not in this tenant")
    const n = await exec("insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing", [groupId, userId], db)
    if (!n) return false
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.group_member_added", entityType: "group", entityId: groupId, summary: `${u.email} added to ${g.name}`, data: { user_id: userId, email: u.email } },
      db
    )
    return true
  })
}

export async function removeGroupMember(actor: Actor, groupId: string, userId: string): Promise<boolean> {
  assertPermission(actor, "admin.users")
  if (!isUuid(groupId) || !isUuid(userId)) throw notFound("Member not found")
  return tx(async (db) => {
    const g = await q1<{ name: string }>("select name from groups where id = $1 and tenant_id = $2", [groupId, actor.tenantId], db)
    if (!g) throw notFound("Group not found")
    const u = await q1<{ email: string }>("select email from users where id = $1 and tenant_id = $2", [userId, actor.tenantId], db)
    const n = await exec("delete from group_members where group_id = $1 and user_id = $2", [groupId, userId], db)
    if (!n) return false
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.group_member_removed", entityType: "group", entityId: groupId, summary: `${u?.email ?? userId} removed from ${g.name}`, data: { user_id: userId, email: u?.email ?? null } },
      db
    )
    return true
  })
}

/** Groups of the tenant for selects (memberships, OLA policies). */
export async function groupOptions(actor: Actor) {
  return q<{ id: string; name: string; kind: GroupKind; is_active: boolean }>(
    "select id, name, kind, is_active from groups where tenant_id = $1 order by is_active desc, lower(name)",
    [actor.tenantId]
  )
}
