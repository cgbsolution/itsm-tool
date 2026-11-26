/**
 * REST API: tickets.
 *   GET  /api/v1/tickets?type=&view=&assignee=&group=&priority=&q=&sort=&page=&page_size=
 *   POST /api/v1/tickets   { type, subject, description, requesterId?, categoryId?, impact?, urgency?, priority?, ... }
 * Auth: Authorization: Bearer itsm_pat_… (Admin › API tokens), acting as the token's user.
 */
import type { NextRequest } from "next/server"
import { apiActor, apiError, json } from "@/lib/api"
import { listTickets } from "@/lib/itsm/queries"
import { createTicket, type CreateTicketInput } from "@/lib/itsm/tickets"
import { enforce } from "@/lib/rate-limit"
import { AppError } from "@/lib/errors"

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor(req)
    const sp = req.nextUrl.searchParams
    const r = await listTickets(actor, {
      type: sp.get("type") ?? undefined,
      view: sp.get("view") ?? "active",
      assignee: sp.get("assignee") ?? undefined,
      group: sp.get("group") ?? undefined,
      priority: sp.get("priority") ?? undefined,
      requester: sp.get("requester") ?? undefined,
      sla: sp.get("sla") ?? undefined,
      q: sp.get("q") ?? undefined,
      sort: sp.get("sort") ?? undefined,
      page: Number(sp.get("page")) || 1,
      pageSize: Number(sp.get("page_size")) || 50,
    })
    return json({ data: r.rows.map(({ total: _t, ...row }) => row), page: r.page, page_size: r.pageSize, total: r.total })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await apiActor(req)
    await enforce(`api:create:${actor.id}`, 120, 60)
    const body = (await req.json().catch(() => null)) as (CreateTicketInput & { plannedStart?: string; plannedEnd?: string }) | null
    if (!body || typeof body !== "object") throw new AppError("Send a JSON body")
    const t = await createTicket(actor, {
      ...body,
      source: "api",
      plannedStart: body.plannedStart ? new Date(body.plannedStart) : undefined,
      plannedEnd: body.plannedEnd ? new Date(body.plannedEnd) : undefined,
    })
    return json({ id: t.id, number: t.number, status: t.status, priority: t.priority, url: `/tickets/${t.number}` }, 201)
  } catch (e) {
    return apiError(e)
  }
}
