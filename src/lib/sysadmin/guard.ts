/** Shared helpers for system-administration services. */
import type { Actor } from "@/lib/auth/session"
import { clientIp } from "@/lib/auth/session"
import type { Permission } from "@/lib/auth/permissions"
import { forbidden } from "@/lib/errors"
import { permissionsFor, isSystemRole, SYSTEM_ROLES } from "@/lib/auth/permissions"
import { q, type Db, pool } from "@/lib/db"

/** Services re-check the permission themselves (a hidden button is not security). */
export function need(actor: Actor, perm: Permission): void {
  if (!actor.permissions.has(perm)) throw forbidden()
}

export function auditActor(actor: Actor) {
  return { id: actor.id, email: actor.email }
}

/** The caller's IP for the audit log, when there is a request (null in jobs and tests). */
export async function requestIp(): Promise<string | null> {
  try {
    return await clientIp()
  } catch {
    return null
  }
}

/** Role keys that may be given to accounts in a tenant (never superadmin). */
export async function assignableRoles(tenantId: string, db: Db = pool()): Promise<{ key: string; name: string }[]> {
  const custom = await q<{ key: string; name: string }>("select key, name from custom_roles where tenant_id = $1 order by name", [tenantId], db)
  const system = (Object.keys(SYSTEM_ROLES) as (keyof typeof SYSTEM_ROLES)[])
    .filter((k) => k !== "superadmin")
    .map((k) => ({ key: k, name: SYSTEM_ROLES[k].name }))
  return [...system, ...custom]
}

/** Permissions a user's role grants (system role or the tenant's custom role). */
export async function permissionsOfUser(tenantId: string, role: string, db: Db = pool()) {
  if (isSystemRole(role)) return permissionsFor(role)
  const r = await q<{ permissions: string[] }>("select permissions from custom_roles where tenant_id = $1 and key = $2", [tenantId, role], db)
  return permissionsFor(role, r[0]?.permissions ?? [])
}
