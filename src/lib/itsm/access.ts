/**
 * Who may do what on a ticket. Used by the ticket page (which buttons to show)
 * and by the ticket service (enforcing the same rules).
 *
 * Ported from the legacy ticket-access.ts and extended:
 * - The IT team (ticket.view_all) sees every ticket of the tenant.
 * - With strict assignment (the legacy behaviour, default), only the assignee
 *   works a ticket; people with ticket.assign may act on any ticket.
 *   Without strict assignment any engineer may work any ticket.
 * - Unassigned tickets are picked up ("acquired") first.
 * - Problems need problem.manage, changes need change.manage.
 * - The requester sees and replies on their own ticket, can confirm or reopen
 *   a resolution (within the reopen window) and cancel while it is new.
 */
import type { Permission } from "@/lib/auth/permissions"
import { availableTransitions, isTerminal, type Transition } from "@/lib/itsm/workflow"
import type { TicketType } from "@/lib/itsm/vocab"

export type AccessActor = {
  id: string
  tenantId: string
  permissions: Set<Permission>
  groupIds: string[]
  strictAssignment: boolean
}

export type AccessTicket = {
  tenant_id: string
  ticket_type: TicketType
  status: string
  requester_id: string | null
  created_by: string | null
  assignee_id: string | null
  assignment_group_id: string | null
  resolved_at: Date | string | null
}

export type TicketAccess = {
  canView: boolean
  isRequester: boolean
  isAssignee: boolean
  isStaff: boolean
  canWork: boolean
  canAcquire: boolean
  canAssign: boolean
  canCommentPublic: boolean
  canCommentInternal: boolean
  canSeeInternal: boolean
  canLink: boolean
  canDelete: boolean
  transitions: Transition[]
}

function typePermission(type: TicketType): Permission {
  if (type === "problem") return "problem.manage"
  if (type === "change") return "change.manage"
  return "ticket.work"
}

export function ticketAccess(
  me: AccessActor,
  t: AccessTicket,
  opts: { isWatcher?: boolean; reopenWindowDays?: number; now?: Date } = {}
): TicketAccess {
  const none: TicketAccess = {
    canView: false, isRequester: false, isAssignee: false, isStaff: false, canWork: false, canAcquire: false,
    canAssign: false, canCommentPublic: false, canCommentInternal: false, canSeeInternal: false, canLink: false,
    canDelete: false, transitions: [],
  }
  if (me.tenantId !== t.tenant_id) return none

  const perms = me.permissions
  const isStaff = perms.has("ticket.view_all")
  const worker = perms.has("ticket.work") && perms.has(typePermission(t.ticket_type))
  const assigner = perms.has("ticket.assign") && perms.has(typePermission(t.ticket_type))
  const isRequester = !!t.requester_id && t.requester_id === me.id
  const isAssignee = !!t.assignee_id && t.assignee_id === me.id
  const inGroup = !!t.assignment_group_id && me.groupIds.includes(t.assignment_group_id)
  const isOwner = t.ticket_type === "change" && t.created_by === me.id
  const terminal = isTerminal(t.status)

  const canView = isStaff || isRequester || isAssignee || inGroup || !!opts.isWatcher || isOwner
  if (!canView) return none

  const canWork = worker && (isAssignee || assigner || isOwner || !me.strictAssignment)
  const canAcquire = worker && !t.assignee_id && !terminal
  const canAssign = !terminal && (assigner || (worker && isAssignee))

  const as: ("worker" | "requester")[] = []
  if (canWork) as.push("worker")
  let transitions = availableTransitions(t.ticket_type, t.status, canWork ? ["worker"] : [])
  if (isRequester && !canWork) {
    const days = opts.reopenWindowDays ?? 7
    const now = (opts.now ?? new Date()).getTime()
    const resolvedAt = t.resolved_at ? new Date(t.resolved_at).getTime() : 0
    const withinWindow = !!resolvedAt && now - resolvedAt <= days * 86_400_000
    transitions = availableTransitions(t.ticket_type, t.status, ["requester"]).filter((tr) => {
      if (tr.action === "reopen") return withinWindow
      if (tr.action === "cancel") return t.status === "new" || t.status === "pending_approval"
      return true
    })
  }

  return {
    canView,
    isRequester,
    isAssignee,
    isStaff,
    canWork,
    canAcquire,
    canAssign,
    canCommentPublic: !terminal && (isRequester || canWork || (worker && inGroup)),
    canCommentInternal: worker || (isStaff && perms.has("ticket.work")),
    canSeeInternal: isStaff,
    canLink: canWork || (isStaff && perms.has("ticket.work")),
    canDelete: perms.has("ticket.delete"),
    transitions,
  }
}
