/**
 *   GET  /api/v1/tickets/{number}                   ticket, comments (internal only for IT staff), SLA clocks, links
 *   POST /api/v1/tickets/{number}  { comment, internal? }                 add a comment
 *   POST /api/v1/tickets/{number}  { action, comment?, resolutionCode?, … } run a workflow action
 */
import type { NextRequest } from "next/server"
import { apiActor, apiError, json } from "@/lib/api"
import { getTicketDetail } from "@/lib/itsm/queries"
import { addComment, transitionTicket } from "@/lib/itsm/tickets"
import { AppError } from "@/lib/errors"

export async function GET(req: NextRequest, { params }: { params: Promise<{ number: string }> }) {
  try {
    const actor = await apiActor(req)
    const d = await getTicketDetail(actor, (await params).number)
    const t = d.ticket
    return json({
      id: t.id,
      number: t.number,
      type: t.ticket_type,
      status: t.status,
      subject: t.subject,
      description: t.description,
      priority: t.priority,
      impact: t.impact,
      urgency: t.urgency,
      category: t.category,
      sub_category: t.sub_category,
      requester: t.requester_full_name ?? t.requester_name,
      assignee: t.assignee_name,
      group: t.group_name,
      created_at: t.created_at,
      updated_at: t.updated_at,
      resolved_at: t.resolved_at,
      closed_at: t.closed_at,
      resolution: t.resolution_notes,
      sla: d.clocks.map((c) => ({ kind: c.kind, status: c.status, due_at: c.due_at, breached: c.breached })),
      comments: d.comments.map((c) => ({ author: c.author_name ?? c.author_label, body: c.body, internal: c.is_internal, created_at: c.created_at })),
      links: d.links.map((l) => ({ type: l.link_type, direction: l.direction, number: l.other_number })),
      configuration_items: d.cis.map((c) => ({ code: c.ci_code, name: c.name, role: c.role })),
      available_actions: d.access.transitions.map((tr) => tr.action),
      version: t.version,
    })
  } catch (e) {
    return apiError(e)
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ number: string }> }) {
  try {
    const actor = await apiActor(req)
    const d = await getTicketDetail(actor, (await params).number)
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) throw new AppError("Send a JSON body")
    if (typeof body.action === "string") {
      const t = await transitionTicket(actor, d.ticket.id, body.action, {
        version: typeof body.version === "number" ? body.version : undefined,
        comment: (body.comment as string) ?? null,
        holdReason: (body.holdReason as string) ?? null,
        holdHours: (body.holdHours as number) ?? null,
        resolutionCode: (body.resolutionCode as string) ?? null,
        resolutionNotes: (body.resolutionNotes as string) ?? null,
        rootCause: (body.rootCause as string) ?? null,
        workaround: (body.workaround as string) ?? null,
        outcome: (body.outcome as string) ?? null,
      })
      return json({ number: t.number, status: t.status, version: t.version })
    }
    if (typeof body.comment === "string") {
      const r = await addComment(actor, d.ticket.id, { body: body.comment, internal: body.internal === true, source: "api" })
      return json({ comment_id: r.id, status: r.ticket.status }, 201)
    }
    throw new AppError('Send { "comment": "…" } or { "action": "…" }')
  } catch (e) {
    return apiError(e)
  }
}
