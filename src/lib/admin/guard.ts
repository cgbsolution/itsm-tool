/** Shared checks for the administration services. */
import { q, q1, type Db, pool } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { forbidden } from "@/lib/errors"
import { SYSTEM_ROLES, isSystemRole, permissionsFor, type Permission } from "@/lib/auth/permissions"
import type { AuditActor } from "@/lib/audit"

/** Services re-check the permission: a hidden button is not security. */
export function assertPermission(actor: Actor, perm: Permission): void {
  if (!actor.permissions.has(perm)) throw forbidden()
}

export function auditActor(actor: Actor): AuditActor {
  return actor.isSystem ? null : { id: actor.id, email: actor.email }
}

/** Permissions of a role key in a tenant, or null when the role does not exist there. */
export async function rolePermissions(tenantId: string, role: string, db: Db = pool()): Promise<Set<Permission> | null> {
  if (isSystemRole(role)) return permissionsFor(role)
  const r = await q1<{ permissions: string[] }>("select permissions from custom_roles where tenant_id = $1 and key = $2", [tenantId, role], db)
  return r ? permissionsFor(role, r.permissions) : null
}

/** Display names of every role key used in a tenant (system + custom). */
export async function roleNames(tenantId: string, db: Db = pool()): Promise<Record<string, string>> {
  const names: Record<string, string> = Object.fromEntries(Object.entries(SYSTEM_ROLES).map(([k, v]) => [k, v.name]))
  for (const r of await q<{ key: string; name: string }>("select key, name from custom_roles where tenant_id = $1", [tenantId], db)) names[r.key] = r.name
  return names
}

/**
 * Nobody can hand out (or take away) more than they hold: the role's
 * permissions must be a subset of the actor's. A super admin passes.
 */
export function assertCanGrant(actor: Actor, role: string, perms: Set<Permission>, what: "assign" | "change"): void {
  if (actor.isSuperadmin) return
  if (role === "superadmin") {
    throw forbidden(
      what === "assign"
        ? "Only a super administrator can grant the super administrator role"
        : "Only a super administrator can change a super administrator's account"
    )
  }
  const missing = [...perms].filter((p) => !actor.permissions.has(p))
  if (missing.length) {
    throw forbidden(
      what === "assign"
        ? `You cannot assign a role with permissions you do not hold yourself (${missing.join(", ")})`
        : `You cannot change an account that holds permissions you do not have (${missing.join(", ")})`
    )
  }
}
