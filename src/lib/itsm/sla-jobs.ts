/** Scheduled ITSM work: SLA breaches and warnings, hold expiry, auto-close. */
import { q, q1, exec, tx, pool } from "@/lib/db"
import { findDueClocks, markBreached, markWarned, refreshSummary } from "@/lib/itsm/sla"
import { ticketEvent, type EventTicket } from "@/lib/itsm/events"
import { systemActor } from "@/lib/auth/system"
import { transitionTicket } from "@/lib/itsm/tickets"
import { log } from "@/lib/log"

const EVENT_COLUMNS = "id, tenant_id, number, ticket_type, subject, status, priority, requester_id, assignee_id, assignment_group_id, created_by, resolution_notes"

export async function runSlaCheck(): Promise<void> {
  const now = new Date()
  const { breaches, warnings } = await findDueClocks(pool(), now)
  for (const c of breaches) {
    await tx(async (db) => {
      if (!(await markBreached(db, c.id))) return
      await refreshSummary(db, c.ticket_id)
      const t = await q1<EventTicket>(`select ${EVENT_COLUMNS} from tickets where id = $1`, [c.ticket_id], db)
      if (!t) return
      await exec("insert into ticket_activity (tenant_id, ticket_id, action, details) values ($1, $2, 'sla_breached', $3)", [t.tenant_id, t.id, JSON.stringify({ kind: c.kind, due_at: c.due_at })], db)
      await ticketEvent(db, t, null, { kind: "sla_breach", slaKind: c.kind, dueAt: c.due_at, groupId: c.group_id })
    }).catch((err) => log.error("sla.breach_failed", { clock: c.id, err }))
  }
  for (const c of warnings) {
    await tx(async (db) => {
      if (!(await markWarned(db, c.id, now))) return
      const t = await q1<EventTicket>(`select ${EVENT_COLUMNS} from tickets where id = $1`, [c.ticket_id], db)
      if (!t) return
      await exec("insert into ticket_activity (tenant_id, ticket_id, action, details) values ($1, $2, 'sla_warning', $3)", [t.tenant_id, t.id, JSON.stringify({ kind: c.kind, due_at: c.due_at })], db)
      await ticketEvent(db, t, null, { kind: "sla_warning", slaKind: c.kind, dueAt: c.due_at })
    }).catch((err) => log.error("sla.warning_failed", { clock: c.id, err }))
  }

  // holds end by themselves (legacy: hold_until was never acted on)
  const expired = await q<{ id: string; tenant_id: string }>("select id, tenant_id from tickets where status = 'on_hold' and hold_until <= now() order by hold_until limit 200")
  for (const t of expired) {
    await transitionTicket(systemActor(t.tenant_id), t.id, "resume", { comment: "The hold period ended" }).catch((err) =>
      log.warn("sla.hold_resume_failed", { ticket: t.id, err })
    )
  }
  if (breaches.length || warnings.length || expired.length) {
    log.info("sla.check", { breaches: breaches.length, warnings: warnings.length, holds_ended: expired.length })
  }
}

export async function runAutoClose(): Promise<void> {
  const rows = await q<{ id: string; tenant_id: string }>(
    `select t.id, t.tenant_id from tickets t join tenant_settings s on s.tenant_id = t.tenant_id
      where t.status = 'resolved' and s.auto_close_resolved_days > 0
        and t.resolved_at < now() - make_interval(days => s.auto_close_resolved_days)
      order by t.resolved_at limit 500`
  )
  for (const t of rows) {
    await transitionTicket(systemActor(t.tenant_id), t.id, "close", { comment: "Closed automatically after resolution" }).catch((err) =>
      log.warn("tickets.autoclose_failed", { ticket: t.id, err })
    )
  }
}

export async function runCleanup(): Promise<void> {
  await exec("delete from sessions where expires_at < now()")
  await exec("delete from auth_tokens where expires_at < now() - interval '7 days'")
  await exec("delete from rate_limits where window_start < now() - interval '1 day'")
  await exec("delete from jobs where (status = 'done' and finished_at < now() - interval '14 days') or (status = 'dead' and finished_at < now() - interval '90 days')")
  await exec("delete from notifications where is_read and created_at < now() - interval '180 days'")
  await exec("delete from email_outbox where status in ('sent', 'skipped') and created_at < now() - interval '90 days'")
}
