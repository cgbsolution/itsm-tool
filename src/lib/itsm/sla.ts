/**
 * SLA / OLA engine. Each clock is a row in ticket_sla:
 *   response / resolution        – customer SLA (policy by type × priority)
 *   ola_response / ola_resolution – per support group (OLA policy for the group)
 * Clocks pause while a ticket waits (on hold, awaiting approval), the
 * resolution clock pauses when resolved and resumes if reopened, and all
 * clocks are finalised when the ticket is closed or cancelled.
 */
import { q, q1, exec, type Db } from "@/lib/db"
import { addSlaMinutes, deadlineAfterPause, slaMinutesBetween, type WorkCalendar } from "@/lib/itsm/clock"
import { pickPolicy, type ItsmConfig, type SlaPolicyRow } from "@/lib/itsm/config"
import { STATE_CATEGORY, type Status } from "@/lib/itsm/workflow"
import type { Priority, TicketType } from "@/lib/itsm/vocab"

export type SlaKind = "response" | "resolution" | "ola_response" | "ola_resolution"

type ClockRow = {
  id: string
  kind: SlaKind
  business_hours: boolean
  status: string
  due_at: Date
  paused_at: Date | null
  paused_minutes: number
  breached: boolean
  started_at: Date
  target_minutes: number
}

export type SlaTicket = {
  id: string
  tenant_id: string
  ticket_type: TicketType
  priority: Priority
  assignment_group_id: string | null
  created_at: Date
  status: string
  first_response_at?: Date | null
}

function clockFor(config: ItsmConfig, businessHours: boolean): WorkCalendar | null {
  return businessHours ? config.calendar : null
}

async function insertClock(
  db: Db,
  t: SlaTicket,
  kind: SlaKind,
  policy: SlaPolicyRow,
  minutes: number,
  from: Date,
  config: ItsmConfig,
  groupId: string | null
) {
  const due = addSlaMinutes(from, minutes, clockFor(config, policy.business_hours))
  await exec(
    `insert into ticket_sla (tenant_id, ticket_id, kind, policy_id, group_id, target_minutes, business_hours, warn_percent, started_at, due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [t.tenant_id, t.id, kind, policy.id, groupId, minutes, policy.business_hours, policy.warn_percent, from, due],
    db
  )
}

/** Starts the customer SLA clocks (and OLA clocks for the assigned group). */
export async function startClocks(db: Db, t: SlaTicket, config: ItsmConfig, from: Date): Promise<void> {
  const policy = pickPolicy(config.policies, "sla", t.ticket_type, t.priority)
  if (policy) {
    if (!t.first_response_at) await insertClock(db, t, "response", policy, policy.response_minutes, from, config, null)
    await insertClock(db, t, "resolution", policy, policy.resolution_minutes, from, config, null)
  }
  if (t.assignment_group_id) await startOlaClocks(db, t, config, from)
  if (STATE_CATEGORY[t.status as Status] === "paused") await pauseClocks(db, t.id, from)
  await refreshSummary(db, t.id)
}

export async function startOlaClocks(db: Db, t: SlaTicket, config: ItsmConfig, from: Date): Promise<void> {
  if (!t.assignment_group_id) return
  const ola = pickPolicy(config.policies, "ola", t.ticket_type, t.priority, t.assignment_group_id)
  if (!ola) return
  await insertClock(db, t, "ola_response", ola, ola.response_minutes, from, config, t.assignment_group_id)
  await insertClock(db, t, "ola_resolution", ola, ola.resolution_minutes, from, config, t.assignment_group_id)
}

/** Assignment group changed: the old group's OLA clocks are cancelled and the new group's start. */
export async function onGroupChange(db: Db, t: SlaTicket, config: ItsmConfig, now: Date): Promise<void> {
  await exec(
    `update ticket_sla set status = 'cancelled', stopped_at = $2
      where ticket_id = $1 and kind in ('ola_response', 'ola_resolution') and status in ('active', 'paused')`,
    [t.id, now],
    db
  )
  await startOlaClocks(db, t, config, now)
}

/**
 * Priority changed: running clocks are replaced with ones for the new
 * priority, counted from when the ticket was raised (ITIL re-prioritisation).
 */
export async function onPriorityChange(db: Db, t: SlaTicket, config: ItsmConfig, now: Date): Promise<void> {
  const running = await q<{ kind: SlaKind; paused_minutes: number }>(
    "select kind, paused_minutes from ticket_sla where ticket_id = $1 and status in ('active', 'paused')",
    [t.id],
    db
  )
  await exec(
    "update ticket_sla set status = 'cancelled', stopped_at = $2 where ticket_id = $1 and status in ('active', 'paused')",
    [t.id, now],
    db
  )
  const policy = pickPolicy(config.policies, "sla", t.ticket_type, t.priority)
  const ola = t.assignment_group_id ? pickPolicy(config.policies, "ola", t.ticket_type, t.priority, t.assignment_group_id) : null
  for (const r of running) {
    const p = r.kind.startsWith("ola") ? ola : policy
    if (!p) continue
    const minutes = r.kind.endsWith("response") ? p.response_minutes : p.resolution_minutes
    const start = new Date(t.created_at)
    const cal = clockFor(config, p.business_hours)
    // keep paused time already accrued: the new deadline moves out by it
    const due = addSlaMinutes(start, minutes + Number(r.paused_minutes || 0), cal)
    await exec(
      `insert into ticket_sla (tenant_id, ticket_id, kind, policy_id, group_id, target_minutes, business_hours, warn_percent, started_at, due_at, paused_minutes,
                               breached, breached_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10 < $12, case when $10 < $12 then $10 else null end)`,
      [t.tenant_id, t.id, r.kind, p.id, r.kind.startsWith("ola") ? t.assignment_group_id : null, minutes, p.business_hours, p.warn_percent, start, due, r.paused_minutes || 0, now],
      db
    )
  }
  if (STATE_CATEGORY[t.status as Status] === "paused") await pauseClocks(db, t.id, now)
  await refreshSummary(db, t.id)
}

export async function pauseClocks(db: Db, ticketId: string, now: Date, kinds?: SlaKind[]): Promise<void> {
  await exec(
    `update ticket_sla set status = 'paused', paused_at = $2
      where ticket_id = $1 and status = 'active' ${kinds ? "and kind = any($3)" : ""}`,
    kinds ? [ticketId, now, kinds] : [ticketId, now],
    db
  )
}

export async function resumeClocks(db: Db, ticketId: string, config: ItsmConfig, now: Date): Promise<void> {
  const rows = await q<ClockRow>(
    "select id, kind, business_hours, status, due_at, paused_at, paused_minutes, breached, started_at, target_minutes from ticket_sla where ticket_id = $1 and status = 'paused'",
    [ticketId],
    db
  )
  for (const r of rows) {
    if (!r.paused_at) continue
    const cal = clockFor(config, r.business_hours)
    const pausedFor = slaMinutesBetween(new Date(r.paused_at), now, cal)
    const due = deadlineAfterPause(new Date(r.due_at), new Date(r.paused_at), now, cal)
    await exec(
      "update ticket_sla set status = 'active', paused_at = null, paused_minutes = paused_minutes + $2, due_at = $3 where id = $1",
      [r.id, pausedFor, due],
      db
    )
  }
}

/** Finalises clocks: met or breached (by when they stopped), or cancelled. */
export async function stopClocks(db: Db, ticketId: string, now: Date, opts: { kinds?: SlaKind[]; cancel?: boolean } = {}): Promise<void> {
  const where = opts.kinds ? "and kind = any($3)" : ""
  const params: unknown[] = opts.kinds ? [ticketId, now, opts.kinds] : [ticketId, now]
  if (opts.cancel) {
    await exec(`update ticket_sla set status = 'cancelled', stopped_at = $2 where ticket_id = $1 and status in ('active', 'paused') ${where}`, params, db)
    return
  }
  await exec(
    `update ticket_sla set
        stopped_at = coalesce(paused_at, $2),
        breached = breached or coalesce(paused_at, $2) > due_at,
        breached_at = case when breached then breached_at when coalesce(paused_at, $2) > due_at then due_at else null end,
        status = case when breached or coalesce(paused_at, $2) > due_at then 'breached' else 'met' end
      where ticket_id = $1 and status in ('active', 'paused') ${where}`,
    params,
    db
  )
}

/** First response by the IT team (assignment, public reply, or any action). */
export async function markResponded(db: Db, ticketId: string, now: Date): Promise<void> {
  const changed = await exec(
    "update tickets set first_response_at = $2 where id = $1 and first_response_at is null",
    [ticketId, now],
    db
  )
  if (changed) {
    await stopClocks(db, ticketId, now, { kinds: ["response"] })
    await refreshSummary(db, ticketId)
  }
}

/** Assigned to a person: the group's OLA response clock is met. */
export async function markOlaResponded(db: Db, ticketId: string, now: Date): Promise<void> {
  await stopClocks(db, ticketId, now, { kinds: ["ola_response"] })
}

/** Reacts to a status change: pause, resume, stop. */
export async function onStatusChange(db: Db, ticketId: string, from: string, to: string, config: ItsmConfig, now: Date): Promise<void> {
  const fc = STATE_CATEGORY[from as Status]
  const tc = STATE_CATEGORY[to as Status]
  if (fc === tc) return
  if (tc === "paused") {
    await pauseClocks(db, ticketId, now)
  } else if (tc === "resolved") {
    // resolving counts as responding; resolution clocks stop (paused) and finish on close
    await stopClocks(db, ticketId, now, { kinds: ["response", "ola_response"] })
    await exec("update tickets set first_response_at = coalesce(first_response_at, $2) where id = $1", [ticketId, now], db)
    await pauseClocks(db, ticketId, now)
  } else if (tc === "open") {
    if (fc === "paused" || fc === "resolved") await resumeClocks(db, ticketId, config, now)
  } else if (tc === "done") {
    await stopClocks(db, ticketId, now, { cancel: to === "cancelled" || to === "rejected" })
  }
  await refreshSummary(db, ticketId)
}

/** Copies the current customer clocks onto the ticket row (for lists and filters). */
export async function refreshSummary(db: Db, ticketId: string): Promise<void> {
  await exec(
    `update tickets t set
        sla_response_due = r.due_at, sla_response_breached = coalesce(r.breached, false),
        sla_resolution_due = s.due_at, sla_resolution_breached = coalesce(s.breached, false),
        sla_policy_id = coalesce(s.policy_id, r.policy_id), sla_business_hours = coalesce(s.business_hours, r.business_hours, false)
       from (select 1) one
       left join lateral (select due_at, breached, policy_id, business_hours from ticket_sla
                           where ticket_id = $1 and kind = 'response' and status <> 'cancelled'
                           order by created_at desc limit 1) r on true
       left join lateral (select due_at, breached, policy_id, business_hours from ticket_sla
                           where ticket_id = $1 and kind = 'resolution' and status <> 'cancelled'
                           order by created_at desc limit 1) s on true
      where t.id = $1`,
    [ticketId],
    db
  )
}

export type DueClock = {
  id: string
  ticket_id: string
  tenant_id: string
  kind: SlaKind
  due_at: Date
  breached: boolean
  warned_at: Date | null
  group_id: string | null
}

/** Clocks that have just breached, or crossed their warning threshold. */
export async function findDueClocks(db: Db, now: Date): Promise<{ breaches: DueClock[]; warnings: DueClock[] }> {
  const breaches = await q<DueClock>(
    `select id, ticket_id, tenant_id, kind, due_at, breached, warned_at, group_id from ticket_sla
      where status = 'active' and not breached and due_at <= $1
      order by due_at limit 500`,
    [now],
    db
  )
  const warnings = await q<DueClock>(
    `select id, ticket_id, tenant_id, kind, due_at, breached, warned_at, group_id from ticket_sla
      where status = 'active' and not breached and warned_at is null and due_at > $1
        and $1 >= started_at + (due_at - started_at) * (warn_percent / 100.0)
      order by due_at limit 500`,
    [now],
    db
  )
  return { breaches, warnings }
}

export async function markBreached(db: Db, clockId: string): Promise<boolean> {
  const n = await exec("update ticket_sla set breached = true, breached_at = due_at where id = $1 and not breached", [clockId], db)
  return n > 0
}

export async function markWarned(db: Db, clockId: string, now: Date): Promise<boolean> {
  const n = await exec("update ticket_sla set warned_at = $2 where id = $1 and warned_at is null", [clockId, now], db)
  return n > 0
}

export async function clocksForTicket(db: Db, ticketId: string) {
  return q<{
    id: string
    kind: SlaKind
    status: string
    due_at: Date
    started_at: Date
    stopped_at: Date | null
    paused_minutes: number
    breached: boolean
    business_hours: boolean
    target_minutes: number
    group_name: string | null
  }>(
    `select s.id, s.kind, s.status, s.due_at, s.started_at, s.stopped_at, s.paused_minutes, s.breached, s.business_hours,
            s.target_minutes, g.name as group_name
       from ticket_sla s left join groups g on g.id = s.group_id
      where s.ticket_id = $1 and s.status <> 'cancelled'
      order by s.created_at`,
    [ticketId],
    db
  )
}

export async function ticketForSla(db: Db, ticketId: string): Promise<SlaTicket | null> {
  return q1<SlaTicket>(
    "select id, tenant_id, ticket_type, priority, assignment_group_id, created_at, status, first_response_at from tickets where id = $1",
    [ticketId],
    db
  )
}
