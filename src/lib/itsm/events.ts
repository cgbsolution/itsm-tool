/**
 * Who hears about a ticket event, in the app and by email.
 * Routing ported from the legacy ticket-notify.ts and extended:
 *
 *   Event              Requester          Assignee           Group / IT team         Admins
 *   created            email (receipt)    web + email        web (group or IT team)  —
 *   assigned           web + email        web + email        previous assignee: web  —
 *   status changed     web + email        web                —                       —
 *   resolved           web + email        —                  —                       —
 *   public comment     web + email*       web + email*       watchers: web           —
 *   internal note      —                  web                —                       —
 *   sla warning        —                  web + email        group if unassigned     —
 *   sla breach         —                  web + email        group manager           web + email
 *   approval requested approvers: web + email
 *   approval decided   web + email (requester / change owner)
 *   * the side that did not write the comment
 */
import { q, q1, type Db } from "@/lib/db"
import { config } from "@/lib/config"
import { notify, staffUserIds, adminUserIds, groupMemberIds } from "@/lib/notify"
import { PRIORITY_LABELS, TICKET_TYPE_LABELS, type Priority, type TicketType } from "@/lib/itsm/vocab"
import { STATUS_LABELS, type Status } from "@/lib/itsm/workflow"

export type EventTicket = {
  id: string
  tenant_id: string
  number: string
  ticket_type: TicketType
  subject: string
  status: string
  priority: string
  requester_id: string | null
  assignee_id: string | null
  assignment_group_id: string | null
  created_by: string | null
  resolution_notes?: string | null
}

export type TicketEvent =
  | { kind: "created"; onBehalf: boolean }
  | { kind: "assigned"; previousAssigneeId: string | null; note?: string | null }
  | { kind: "group_assigned"; groupId: string }
  | { kind: "status"; from: string; to: string; comment?: string | null }
  | { kind: "comment"; body: string; internal: boolean; byRequester: boolean }
  | { kind: "sla_warning"; slaKind: string; dueAt: Date }
  | { kind: "sla_breach"; slaKind: string; dueAt: Date; groupId: string | null }
  | { kind: "approval_requested"; approverIds: string[]; details?: string }
  | { kind: "approval_decided"; approved: boolean; comment?: string | null }

export function ticketUrl(number: string) {
  return `${config.appUrl()}/tickets/${number}`
}

async function names(db: Db, ids: (string | null)[]) {
  const list = ids.filter((v): v is string => !!v)
  if (!list.length) return new Map<string, string>()
  const rows = await q<{ id: string; full_name: string; email: string }>(
    "select id, full_name, email from users where id = any($1::uuid[])",
    [list],
    db
  )
  return new Map(rows.map((r) => [r.id, r.full_name || r.email]))
}

const SLA_KIND_LABEL: Record<string, string> = {
  response: "response",
  resolution: "resolution",
  ola_response: "group response (OLA)",
  ola_resolution: "group resolution (OLA)",
}

export async function ticketEvent(db: Db, t: EventTicket, actorId: string | null, ev: TicketEvent): Promise<void> {
  const nm = await names(db, [t.requester_id, t.assignee_id, actorId])
  const actorName = (actorId && nm.get(actorId)) || "Service desk"
  const settings = await q1<{ reopen_window_days: number; timezone: string }>(
    "select reopen_window_days, timezone from tenant_settings where tenant_id = $1",
    [t.tenant_id],
    db
  )
  const tz = settings?.timezone || "UTC"
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(d))
  const url = ticketUrl(t.number)
  const base = {
    ticket: {
      number: t.number,
      subject: t.subject,
      type: TICKET_TYPE_LABELS[t.ticket_type],
      priority: PRIORITY_LABELS[t.priority as Priority] ?? t.priority,
      status: STATUS_LABELS[t.status as Status] ?? t.status,
      requester: (t.requester_id && nm.get(t.requester_id)) || "",
      assignee: (t.assignee_id && nm.get(t.assignee_id)) || "Unassigned",
      url,
      resolution: t.resolution_notes ?? "",
    },
    actor: { name: actorName },
    reopen_days: settings?.reopen_window_days ?? 7,
  }
  const common = { tenantId: t.tenant_id, actorId, link: `/tickets/${t.number}`, entityType: "ticket", entityId: t.id }
  const ref = t.number

  switch (ev.kind) {
    case "created": {
      if (t.requester_id) {
        await notify(
          {
            ...common,
            recipients: [t.requester_id],
            includeActor: true,
            web: ev.onBehalf,
            kind: "ticket.created",
            title: `${actorName} raised ${ref} for you`,
            email: { template: "ticket.created", vars: base },
          },
          db
        )
      }
      if (t.assignee_id) break // the assignment event informs the assignee
      const team = t.assignment_group_id ? await groupMemberIds(t.assignment_group_id, db) : await staffUserIds(t.tenant_id, db)
      await notify(
        { ...common, recipients: team, kind: "ticket.new", title: `New ${TICKET_TYPE_LABELS[t.ticket_type].toLowerCase()} ${ref}: ${t.subject}` },
        db
      )
      break
    }
    case "assigned": {
      if (t.assignee_id) {
        await notify(
          {
            ...common,
            recipients: [t.assignee_id],
            kind: "ticket.assigned",
            title: `${ref} was assigned to you`,
            body: t.subject,
            email: { template: "ticket.assigned", vars: { ...base, note: ev.note ? `Note: ${ev.note}` : "" } },
          },
          db
        )
      }
      if (ev.previousAssigneeId && ev.previousAssigneeId !== t.assignee_id) {
        await notify(
          { ...common, recipients: [ev.previousAssigneeId], kind: "ticket.reassigned", title: `${ref} was transferred to ${base.ticket.assignee}` },
          db
        )
      }
      if (t.requester_id && t.assignee_id) {
        await notify(
          {
            ...common,
            recipients: [t.requester_id],
            kind: "ticket.assigned",
            title: `${base.ticket.assignee} is handling ${ref}`,
            email: { template: "ticket.updated", vars: { ...base, message: `${base.ticket.assignee} is now handling your ${base.ticket.type.toLowerCase()}.` } },
          },
          db
        )
      }
      break
    }
    case "group_assigned": {
      const members = await groupMemberIds(ev.groupId, db)
      await notify({ ...common, recipients: members, kind: "ticket.group", title: `${ref} was routed to your group`, body: t.subject }, db)
      break
    }
    case "status": {
      const to = ev.to as Status
      const label = STATUS_LABELS[to] ?? ev.to
      if (t.requester_id) {
        const resolved = to === "resolved"
        await notify(
          {
            ...common,
            recipients: [t.requester_id],
            kind: "ticket.status",
            title: `${ref} is now ${label.toLowerCase()}`,
            body: ev.comment ?? null,
            email: resolved
              ? { template: "ticket.resolved", vars: base }
              : { template: "ticket.updated", vars: { ...base, message: `${actorName} changed the status to ${label}.`, note: ev.comment ? `Note: ${ev.comment}` : "" } },
          },
          db
        )
      }
      if (t.assignee_id) {
        await notify({ ...common, recipients: [t.assignee_id], kind: "ticket.status", title: `${ref} is now ${label.toLowerCase()}`, body: ev.comment ?? null }, db)
      }
      break
    }
    case "comment": {
      if (ev.internal) {
        await notify({ ...common, recipients: [t.assignee_id], kind: "ticket.note", title: `Internal note on ${ref}`, body: ev.body.slice(0, 200) }, db)
        break
      }
      const watchers = await q<{ user_id: string }>("select user_id from ticket_watchers where ticket_id = $1", [t.id], db)
      const target = ev.byRequester
        ? [t.assignee_id, ...(t.assignee_id ? [] : await groupMemberIds(t.assignment_group_id, db))]
        : [t.requester_id]
      await notify(
        {
          ...common,
          recipients: target,
          kind: "ticket.comment",
          title: `New reply on ${ref}`,
          body: ev.body.slice(0, 200),
          email: { template: "ticket.comment", vars: { ...base, comment: ev.body } },
        },
        db
      )
      await notify({ ...common, recipients: watchers.map((w) => w.user_id).filter((id) => !target.includes(id)), kind: "ticket.comment", title: `New reply on ${ref}` }, db)
      break
    }
    case "sla_warning": {
      const to = t.assignee_id ? [t.assignee_id] : await groupMemberIds(t.assignment_group_id, db)
      const sla = { kind: SLA_KIND_LABEL[ev.slaKind] ?? ev.slaKind, due: fmt(ev.dueAt) }
      await notify(
        { ...common, recipients: to, kind: "sla.warning", title: `${ref}: ${sla.kind} due ${sla.due}`, email: { template: "sla.warning", vars: { ...base, sla } } },
        db
      )
      break
    }
    case "sla_breach": {
      const sla = { kind: SLA_KIND_LABEL[ev.slaKind] ?? ev.slaKind, due: fmt(ev.dueAt) }
      const managers = await q<{ manager_id: string | null }>(
        "select manager_id from groups where id = any($1::uuid[])",
        [[ev.groupId, t.assignment_group_id].filter(Boolean)],
        db
      )
      const recipients = [t.assignee_id, ...managers.map((m) => m.manager_id), ...(await adminUserIds(t.tenant_id, db))]
      await notify(
        { ...common, actorId: null, recipients, kind: "sla.breach", title: `${ref}: ${sla.kind} SLA breached`, body: t.subject, email: { template: "sla.breach", vars: { ...base, sla } } },
        db
      )
      break
    }
    case "approval_requested": {
      await notify(
        {
          ...common,
          recipients: ev.approverIds,
          kind: "approval.requested",
          title: `Approval needed: ${ref}`,
          body: t.subject,
          link: "/approvals",
          email: { template: "approval.requested", vars: { ...base, details: ev.details ?? "", approvals: { url: `${config.appUrl()}/approvals` } } },
        },
        db
      )
      break
    }
    case "approval_decided": {
      const decision = ev.approved ? "approved" : "rejected"
      await notify(
        {
          ...common,
          recipients: [t.requester_id, t.created_by, t.assignee_id],
          kind: "approval.decided",
          title: `${ref} was ${decision}`,
          body: ev.comment ?? null,
          email: { template: "approval.decided", vars: { ...base, decision, note: ev.comment ? `Comment: ${ev.comment}` : "" } },
        },
        db
      )
      break
    }
  }
}
