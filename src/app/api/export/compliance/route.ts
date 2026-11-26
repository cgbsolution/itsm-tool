/** GET /api/export/compliance: patch compliance per active device as CSV (endpoint.view + report.view). */
import type { NextRequest } from "next/server"
import { apiActor, apiError, csvResponse, requirePerm } from "@/lib/api"
import { complianceDevices } from "@/lib/endpoints/queries"
import { OS_LABELS, type OsFamily } from "@/lib/endpoints/vocab"

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor(req)
    requirePerm(actor, "endpoint.view")
    requirePerm(actor, "report.view")
    const rows = await complianceDevices(actor.tenantId)
    const date = new Date().toISOString().slice(0, 10)
    return csvResponse(
      `patch-compliance-${date}.csv`,
      ["Host name", "OS", "Group", "Compliant", "Missing approved security/critical", "Missing (all, not declined)", "Reboot pending", "Last seen (UTC)", "Last scan (UTC)"],
      rows.map((d) => [
        d.hostname,
        d.os_name ?? OS_LABELS[d.os_family as OsFamily] ?? d.os_family,
        d.group_name ?? "",
        d.missing_required === 0 ? "yes" : "no",
        d.missing_required,
        d.missing_any,
        d.reboot_pending ? "yes" : "no",
        d.last_seen_at,
        d.last_scan_at,
      ])
    )
  } catch (e) {
    return apiError(e)
  }
}
