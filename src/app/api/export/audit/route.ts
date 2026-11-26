/**
 * GET /api/export/audit — CSV of the audit log with the filters of
 * /reports/audit (action, actor, entityType, entityId, from, to, tenant).
 * Needs audit.view; a super admin exports all tenants, others their own.
 */
import type { NextRequest } from "next/server"
import { apiActor, apiError, csvResponse, requirePerm } from "@/lib/api"
import { exportAudit, type AuditFilters } from "@/lib/reports/audit"

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor(req)
    requirePerm(actor, "audit.view")
    const sp = req.nextUrl.searchParams
    const get = (k: string) => sp.get(k)?.slice(0, 200) || undefined
    const filters: AuditFilters = {
      action: get("action"),
      actor: get("actor"),
      entityType: get("entityType"),
      entityId: get("entityId"),
      from: get("from"),
      to: get("to"),
      tenant: actor.isSuperadmin ? get("tenant") : undefined,
    }
    const rows = await exportAudit(actor, filters)
    const header = ["id", "time", ...(actor.isSuperadmin ? ["tenant"] : []), "actor", "action", "entity_type", "entity_id", "summary", "ip", "data"]
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    return csvResponse(
      `audit-${stamp}.csv`,
      header,
      rows.map((a) => [
        a.id,
        a.created_at,
        ...(actor.isSuperadmin ? [a.tenant_name ?? "system"] : []),
        a.actor_label,
        a.action,
        a.entity_type,
        a.entity_id,
        a.summary,
        a.ip,
        a.data ? JSON.stringify(a.data) : "",
      ])
    )
  } catch (e) {
    return apiError(e)
  }
}
