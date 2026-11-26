/**
 * Approvals for changes (CAB) and service requests.
 * - "any": one row for the group; any member decides for the group.
 * - "all": one row per member; every member must approve.
 * - Steps run in order (e.g. step 1 line manager, step 2 approver group).
 * - Segregation of duties: nobody approves a change they raised or own.
 */
import { q, q1, exec, tx, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { actorId, systemActor } from "@/lib/auth/system"
import { AppError, forbidden, notFound } from "@/lib/errors"
import { ticketEvent, type EventTicket } from "@/lib/itsm/events"
import { audit } from "@/lib/audit"
import { groupMemberIds } from "@/lib/notify"

export type ApprovalPlan = {
  steps: { groupId?: string | null; approverIds?: string[]; mode: "any" | "all" }[]
  details?: string
}

export async function cancelPendingApprovals(db: Db, ticketId: string): Promise<void> {
  await exec("update approvals set status = 'cancelled', decided_at = now() where ticket_id = $1 and status = 'pending'", [ticketId], db)
}

/** Creates approval rows for a ticket and notifies the first step's approvers. */
export async function requestApprovals(db: Db, actor: Actor, t: EventTicket, plan: ApprovalPlan): Promise<number> {
  await cancelPendingApprovals(db, t.id)
  let created = 0
  let stepNo = 0
  const firstStepApprovers: string[] = []
  for (const s of plan.steps) {
    const hasGroup = !!s.groupId
    const approvers = [...new Set(s.approverIds ?? [])]
    if (!hasGroup && approvers.length === 0) continue
    stepNo++
    const rows: { approver: string | null; group: string | null }[] = []
    if (hasGroup && s.mode === "all") {
      // only people who can actually decide: active, and not the requester / change owner
      for (const m of await eligibleMembers(db, s.groupId!, [t.requester_id, t.created_by])) rows.push({ approver: m, group: s.groupId! })
    } else if (hasGroup) {
      // a group nobody in it can decide for is skipped (falls through to the empty-step check)
      if ((await eligibleMembers(db, s.groupId!, [t.requester_id, t.created_by])).length > 0) rows.push({ approver: null, group: s.groupId! })
    }
    for (const a of approvers) if (a !== t.requester_id && a !== t.created_by) rows.push({ approver: a, group: null })
    if (rows.length === 0) {
      stepNo--
      continue
    }
    for (const r of rows) {
      await exec(
        `insert into approvals (tenant_id, ticket_id, step, approver_id, group_id, requested_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [t.tenant_id, t.id, stepNo, r.approver, r.group, actorId(actor)],
        db
      )
      created++
      if (stepNo === 1) {
        if (r.approver) firstStepApprovers.push(r.approver)
        else firstStepApprovers.push(...(await eligibleMembers(db, r.group!, [t.requester_id, t.created_by])))
      }
    }
  }
  if (created === 0) throw new AppError("No approvers are configured. Set a CAB / approver group first.")
  await activity(db, t, actorId(actor), "approval_requested", { steps: stepNo })
  await ticketEvent(db, t, actorId(actor), {
    kind: "approval_requested",
    approverIds: firstStepApprovers.filter((id) => id !== t.created_by && id !== t.requester_id),
    details: plan.details,
  })
  return created
}

async function eligibleMembers(db: Db, groupId: string, exclude: (string | null)[]): Promise<string[]> {
  const rows = await q<{ user_id: string }>(
    `select gm.user_id from group_members gm join users u on u.id = gm.user_id
      where gm.group_id = $1 and u.status = 'active' and not (gm.user_id = any($2::uuid[]))`,
    [groupId, exclude.filter(Boolean)],
    db
  )
  return rows.map((r) => r.user_id)
}

async function activity(db: Db, t: { id: string; tenant_id: string }, actor: string | null, action: string, details: Record<string, unknown>) {
  await exec(
    "insert into ticket_activity (tenant_id, ticket_id, actor_id, action, details) values ($1, $2, $3, $4, $5)",
    [t.tenant_id, t.id, actor, action, JSON.stringify(details)],
    db
  )
}

export type PendingApproval = {
  id: string
  step: number
  ticket_id: string
  number: string
  ticket_type: string
  subject: string
  priority: string
  status: string
  requested_at: Date
  requested_by_name: string | null
  group_name: string | null
  change_type: string | null
  risk: string | null
  planned_start: Date | null
  planned_end: Date | null
}

/** Approvals the actor can decide now (their step is current). */
export async function myPendingApprovals(actor: Actor): Promise<PendingApproval[]> {
  return q<PendingApproval>(
    `select a.id, a.step, t.id as ticket_id, t.number, t.ticket_type, t.subject, t.priority, t.status, a.requested_at,
            rb.full_name as requested_by_name, g.name as group_name, t.change_type, t.risk, t.planned_start, t.planned_end
       from approvals a
       join tickets t on t.id = a.ticket_id
       left join users rb on rb.id = a.requested_by
       left join groups g on g.id = a.group_id
      where a.tenant_id = $1 and a.status = 'pending'
        and (a.approver_id = $2 or a.group_id = any($3::uuid[]))
        and not exists (select 1 from approvals e where e.ticket_id = a.ticket_id and e.status = 'pending' and e.step < a.step)
        and coalesce(t.created_by, '00000000-0000-0000-0000-000000000000') <> $2
        and coalesce(t.requester_id, '00000000-0000-0000-0000-000000000000') <> $2
      order by a.requested_at`,
    [actor.tenantId, actor.id, actor.groupIds]
  )
}

export async function approvalsForTicket(db: Db, ticketId: string) {
  return q<{
    id: string
    step: number
    status: string
    approver_name: string | null
    group_name: string | null
    decided_by_name: string | null
    decided_at: Date | null
    comment: string | null
    requested_at: Date
  }>(
    `select a.id, a.step, a.status, ap.full_name as approver_name, g.name as group_name, d.full_name as decided_by_name,
            a.decided_at, a.comment, a.requested_at
       from approvals a
       left join users ap on ap.id = a.approver_id
       left join groups g on g.id = a.group_id
       left join users d on d.id = a.decided_by
      where a.ticket_id = $1 and a.status <> 'cancelled'
      order by a.step, a.requested_at`,
    [ticketId],
    db
  )
}

/** Records a decision and moves the ticket on when its approvals are complete. */
export async function decideApproval(actor: Actor, approvalId: string, approve: boolean, comment: string | null): Promise<void> {
  await tx(async (db) => {
    const a = await q1<{ id: string; ticket_id: string; step: number; approver_id: string | null; group_id: string | null; status: string; tenant_id: string }>(
      "select id, ticket_id, step, approver_id, group_id, status, tenant_id from approvals where id = $1 and tenant_id = $2 for update",
      [approvalId, actor.tenantId],
      db
    )
    if (!a) throw notFound("Approval not found")
    if (a.status !== "pending") throw new AppError("This approval has already been decided")
    const mine = a.approver_id === actor.id || (!!a.group_id && actor.groupIds.includes(a.group_id))
    if (!mine) throw forbidden("You are not an approver for this request")
    const earlier = await q1("select 1 from approvals where ticket_id = $1 and status = 'pending' and step < $2", [a.ticket_id, a.step], db)
    if (earlier) throw new AppError("An earlier approval step is still pending")
    const t = await q1<EventTicket & { status: string }>(
      `select id, tenant_id, number, ticket_type, subject, status, priority, requester_id, assignee_id, assignment_group_id, created_by
         from tickets where id = $1 for update`,
      [a.ticket_id],
      db
    )
    if (!t) throw notFound()
    if (t.created_by === actor.id || t.requester_id === actor.id) throw forbidden("You cannot approve your own request or change")
    if (!approve && !comment?.trim()) throw new AppError("Give a reason for rejecting")

    await exec(
      "update approvals set status = $2, decided_by = $3, decided_at = now(), comment = $4 where id = $1",
      [a.id, approve ? "approved" : "rejected", actor.id, comment?.trim() || null],
      db
    )
    await activity(db, t, actor.id, approve ? "approval_approved" : "approval_rejected", { step: a.step, comment })
    await audit(
      {
        tenantId: t.tenant_id,
        actor: { id: actor.id, email: actor.email },
        action: approve ? "approval.approved" : "approval.rejected",
        entityType: "ticket",
        entityId: t.id,
        summary: `${t.number} step ${a.step}`,
      },
      db
    )

    const { transitionTicket } = await import("@/lib/itsm/tickets")
    const sys = systemActor(t.tenant_id)
    if (!approve) {
      await cancelPendingApprovals(db, t.id)
      if (t.status === "pending_approval") await transitionTicket(sys, t.id, "reject_system", { comment: comment ?? "Rejected" }, db)
      await ticketEvent(db, t, actor.id, { kind: "approval_decided", approved: false, comment })
      return
    }
    // group decided "any": other rows of the same group in this step are settled too
    if (a.group_id && !a.approver_id) {
      await exec("update approvals set status = 'approved', decided_by = $3, decided_at = now() where ticket_id = $1 and step = $2 and group_id = $4 and approver_id is null and status = 'pending'", [t.id, a.step, actor.id, a.group_id], db)
    }
    const stillPendingThisStep = await q1("select 1 from approvals where ticket_id = $1 and step = $2 and status = 'pending'", [t.id, a.step], db)
    if (stillPendingThisStep) return
    const next = await q<{ approver_id: string | null; group_id: string | null }>(
      "select approver_id, group_id from approvals where ticket_id = $1 and status = 'pending' and step = (select min(step) from approvals where ticket_id = $1 and status = 'pending')",
      [t.id],
      db
    )
    if (next.length) {
      const ids: string[] = []
      for (const n of next) {
        if (n.approver_id) ids.push(n.approver_id)
        else ids.push(...(await groupMemberIds(n.group_id, db)))
      }
      await ticketEvent(db, t, actor.id, { kind: "approval_requested", approverIds: ids })
      return
    }
    if (t.status === "pending_approval") await transitionTicket(sys, t.id, "approve_system", {}, db)
    await ticketEvent(db, t, actor.id, { kind: "approval_decided", approved: true, comment })
  })
}
