import { ALL_PERMISSIONS } from "@/lib/auth/permissions"
import type { Actor } from "@/lib/auth/session"

/** The actor background jobs use (SLA, hold expiry, auto-close, email-to-ticket). */
export function systemActor(tenantId: string, strictAssignment = false): Actor {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    email: "system",
    name: "System",
    role: "system",
    roleName: "System",
    tenantId,
    homeTenantId: tenantId,
    tenant: {
      id: tenantId,
      name: "",
      slug: "",
      brandName: "",
      brandColor: "#2563eb",
      timezone: "UTC",
      requireMfa: false,
      strictAssignment,
      status: "active",
    },
    permissions: new Set(ALL_PERMISSIONS.filter((p) => p !== "admin.tenants")),
    groupIds: [],
    isSuperadmin: false,
    mfaEnabled: false,
    mustChangePassword: false,
    sessionId: "system",
    isSystem: true,
  }
}

/** The user id to record for an actor (null for the system). */
export function actorId(actor: Pick<Actor, "id" | "isSystem">): string | null {
  return actor.isSystem ? null : actor.id
}
