/**
 * GET /api/export/tickets — CSV of tickets with the same query parameters as
 * /tickets (type, view, assignee, group, priority, requester, sla, q, sort).
 * Needs report.view; at most 50 000 rows.
 */
import type { NextRequest } from "next/server"
import { apiActor, apiError, csvResponse, requirePerm } from "@/lib/api"
import { exportTickets, ticketExportRow, ticketFiltersFrom, TICKET_EXPORT_HEADER } from "@/lib/reports/export"

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor(req)
    requirePerm(actor, "report.view")
    const rows = await exportTickets(actor, ticketFiltersFrom(req.nextUrl.searchParams))
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    return csvResponse(`tickets-${stamp}.csv`, TICKET_EXPORT_HEADER, rows.map(ticketExportRow))
  } catch (e) {
    return apiError(e)
  }
}
