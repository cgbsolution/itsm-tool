/** Ticket export: the /tickets list filters, page by page, up to 50 000 rows. */
import type { Actor } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { forbidden } from "@/lib/errors"
import { listTickets, type TicketFilters, type TicketListRow } from "@/lib/itsm/queries"

export const TICKET_EXPORT_LIMIT = 50_000
const PAGE = 200

export const TICKET_FILTER_KEYS = ["type", "view", "assignee", "group", "priority", "requester", "sla", "q", "sort"] as const

/** The /tickets query parameters (same defaults as the list page). */
export function ticketFiltersFrom(sp: URLSearchParams): TicketFilters {
  const f: Record<string, string | undefined> = {}
  for (const k of TICKET_FILTER_KEYS) f[k] = sp.get(k)?.slice(0, 200) || undefined
  return { ...f, view: f.view ?? "active" }
}

export const TICKET_EXPORT_HEADER = [
  "number", "type", "status", "priority", "subject", "category", "sub_category", "requester", "assignee", "group",
  "created_at", "updated_at", "sla_due", "breached",
]

export function ticketExportRow(t: TicketListRow): unknown[] {
  return [
    t.number, t.ticket_type, t.status, t.priority, t.subject, t.category, t.sub_category, t.requester_name, t.assignee_name, t.group_name,
    t.created_at, t.updated_at, t.sla_resolution_due, t.sla_resolution_breached || t.sla_response_breached ? "yes" : "no",
  ]
}

export async function exportTickets(actor: Actor, filters: TicketFilters): Promise<TicketListRow[]> {
  if (!actor.permissions.has("report.view")) throw forbidden()
  const out: TicketListRow[] = []
  const seen = new Set<string>()
  for (let page = 1; out.length < TICKET_EXPORT_LIMIT; page++) {
    const { rows } = await listTickets(actor, { ...filters, page, pageSize: PAGE })
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
      if (out.length >= TICKET_EXPORT_LIMIT) break
    }
    if (rows.length < PAGE) break
  }
  await audit({
    tenantId: actor.tenantId,
    actor: { id: actor.id, email: actor.email },
    action: "report.tickets_exported",
    entityType: "ticket",
    summary: `Exported ${out.length} tickets to CSV`,
    data: { filters, rows: out.length },
  })
  return out
}
