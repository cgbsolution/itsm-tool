/**
 * Custom roles: a tenant-defined key, name and set of permissions. System
 * roles (user / engineer / admin / superadmin) are fixed in code and read-only.
 * Permissions of a custom role apply on the holder's next request.
 */
import { q, q1, exec, tx, isUuid, isUniqueViolation } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { AppError, forbidden, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import type { Permission } from "@/lib/auth/permissions"
import { assertPermission, auditActor } from "@/lib/admin/guard"
import { cleanPermissions, optionalText, requiredText, roleKeyProblem } from "@/lib/admin/rules"

export type CustomRoleRow = {
  id: string
  key: string
  name: string
  description: string | null
  permissions: Permission[]
  user_count: number
  created_at: Date
}

export async function listCustomRoles(actor: Actor): Promise<CustomRoleRow[]> {
  assertPermission(actor, "admin.users")
  return q<CustomRoleRow>(
    `select r.id, r.key, r.name, r.description, r.permissions, r.created_at,
            (select count(*) from users u where u.tenant_id = r.tenant_id and u.role = r.key) as user_count
       from custom_roles r where r.tenant_id = $1 order by lower(r.name)`,
    [actor.tenantId]
  )
}

/** Number of users per system role key in the tenant. */
export async function systemRoleCounts(actor: Actor): Promise<Record<string, number>> {
  assertPermission(actor, "admin.users")
  const rows = await q<{ role: string; n: number }>("select role, count(*) as n from users where tenant_id = $1 group by role", [actor.tenantId])
  return Object.fromEntries(rows.map((r) => [r.role, r.n]))
}

export async function getCustomRole(actor: Actor, roleId: string): Promise<CustomRoleRow> {
  assertPermission(actor, "admin.users")
  if (!isUuid(roleId)) throw notFound("Role not found")
  const r = await q1<CustomRoleRow>(
    `select r.id, r.key, r.name, r.description, r.permissions, r.created_at,
            (select count(*) from users u where u.tenant_id = r.tenant_id and u.role = r.key) as user_count
       from custom_roles r where r.tenant_id = $1 and r.id = $2`,
    [actor.tenantId, roleId]
  )
  if (!r) throw notFound("Role not found")
  return r
}

export type RoleInput = { key?: unknown; name: unknown; description?: unknown; permissions?: unknown }

/** Nobody hands out permissions they do not hold. */
function assertHolds(actor: Actor, perms: Permission[]) {
  if (actor.isSuperadmin) return
  const missing = perms.filter((p) => !actor.permissions.has(p))
  if (missing.length) throw forbidden(`You cannot grant or remove permissions you do not hold yourself (${missing.join(", ")})`)
}

export async function createCustomRole(actor: Actor, input: RoleInput): Promise<string> {
  assertPermission(actor, "admin.users")
  const key = String(input.key ?? "").trim().toLowerCase()
  const problem = roleKeyProblem(key)
  if (problem) throw new AppError(problem)
  const name = requiredText(input.name, 100, "Name")
  const description = optionalText(input.description, 500, "Description")
  const permissions = cleanPermissions(input.permissions)
  assertHolds(actor, permissions)
  try {
    return await tx(async (db) => {
      const row = await q1<{ id: string }>(
        "insert into custom_roles (tenant_id, key, name, description, permissions) values ($1, $2, $3, $4, $5) returning id",
        [actor.tenantId, key, name, description, permissions],
        db
      )
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.role_created", entityType: "role", entityId: row!.id, summary: `Role ${name} (${key}) created`, data: { key, permissions } },
        db
      )
      return row!.id
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("A role with that key already exists")
    throw e
  }
}

/** Name, description and permissions. The key never changes (users refer to it). */
export async function updateCustomRole(actor: Actor, roleId: string, input: RoleInput): Promise<void> {
  assertPermission(actor, "admin.users")
  if (!isUuid(roleId)) throw notFound("Role not found")
  const name = requiredText(input.name, 100, "Name")
  const description = optionalText(input.description, 500, "Description")
  const permissions = cleanPermissions(input.permissions)
  await tx(async (db) => {
    const before = await q1<{ key: string; name: string; description: string | null; permissions: string[] }>(
      "select key, name, description, permissions from custom_roles where id = $1 and tenant_id = $2 for update",
      [roleId, actor.tenantId],
      db
    )
    if (!before) throw notFound("Role not found")
    const old = cleanPermissions(before.permissions)
    const added = permissions.filter((p) => !old.includes(p))
    const removed = old.filter((p) => !permissions.includes(p))
    assertHolds(actor, [...added, ...removed])
    if (before.key === actor.role && removed.includes("admin.users")) {
      throw new AppError("You hold this role: removing “Manage users, groups and roles” would lock you out of this page")
    }
    if (!added.length && !removed.length && before.name === name && (before.description ?? null) === description) return
    await exec("update custom_roles set name = $3, description = $4, permissions = $5 where id = $1 and tenant_id = $2", [roleId, actor.tenantId, name, description, permissions], db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.role_updated",
        entityType: "role",
        entityId: roleId,
        summary: `Role ${name} (${before.key}) changed`,
        data: { key: before.key, added, removed, ...(before.name !== name ? { name: { from: before.name, to: name } } : {}) },
      },
      db
    )
  })
}

export async function deleteCustomRole(actor: Actor, roleId: string): Promise<void> {
  assertPermission(actor, "admin.users")
  if (!isUuid(roleId)) throw notFound("Role not found")
  await tx(async (db) => {
    const r = await q1<{ key: string; name: string; permissions: Permission[] }>(
      "select key, name, permissions from custom_roles where id = $1 and tenant_id = $2 for update",
      [roleId, actor.tenantId],
      db
    )
    if (!r) throw notFound("Role not found")
    assertHolds(actor, cleanPermissions(r.permissions))
    const held = await q1<{ n: number }>("select count(*) as n from users where tenant_id = $1 and role = $2", [actor.tenantId, r.key], db)
    if (held!.n > 0) throw new AppError(`${held!.n} user${held!.n === 1 ? " holds" : "s hold"} this role. Give them another role first.`)
    await exec("delete from custom_roles where id = $1 and tenant_id = $2", [roleId, actor.tenantId], db)
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.role_deleted", entityType: "role", entityId: roleId, summary: `Role ${r.name} (${r.key}) deleted`, data: { key: r.key, permissions: r.permissions } },
      db
    )
  })
}
