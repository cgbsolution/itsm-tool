/** GET /api/export/cis: configuration items as CSV, with the same filters as /cmdb (max 50,000 rows). */
import type { NextRequest } from "next/server"
import { apiActor, apiError, csvResponse, requirePerm } from "@/lib/api"
import { exportCis, filtersFromParams } from "@/lib/cmdb/queries"
import { todayIn } from "@/lib/cmdb/values"

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor(req)
    requirePerm(actor, "cmdb.view")
    const { header, rows } = await exportCis(actor, filtersFromParams(req.nextUrl.searchParams))
    return csvResponse(`configuration-items-${todayIn(actor.tenant.timezone)}.csv`, header, rows)
  } catch (e) {
    return apiError(e)
  }
}
