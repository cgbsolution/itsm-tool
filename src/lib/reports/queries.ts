/**
 * Service-desk reports for the actor's tenant over a date range: volume,
 * SLA compliance, MTTR / first response, backlog ageing, workload and change
 * success. Times are bucketed by day (or week) in the tenant time zone.
 */
import { q, q1 } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { forbidden } from "@/lib/errors"
import { PRIORITIES, isTicketType, type TicketType } from "@/lib/itsm/vocab"
import {
  AGE_THRESHOLDS_HOURS,
  ageingBuckets,
  changeSuccess,
  fillSeries,
  percent,
  seriesKeys,
  summarizeSla,
  weightedMean,
  type ReportRange,
  type SlaRow,
} from "@/lib/reports/helpers"

/** Statuses that still need work (same as the dashboard). */
const OPEN = "t.status not in ('resolved', 'closed', 'cancelled', 'rejected')"

export type ReportOptions = { range: ReportRange; type?: string | null }

type KeyCount = { key: string; n: number }

export async function ticketReport(actor: Actor, opts: ReportOptions) {
  if (!actor.permissions.has("report.view")) throw forbidden()
  const { range } = opts
  const type: TicketType | null = isTicketType(opts.type) ? opts.type : null
  // $1 tenant, $2 start, $3 end, $4 type (or null), $5 time zone
  const base = [actor.tenantId, range.start, range.end, type, range.tz]
  const typeCond = "($4::text is null or t.ticket_type = $4::text)"
  const bucket = (col: string) =>
    range.granularity === "week" ? `date_trunc('week', ${col} at time zone $5::text)::date` : `(${col} at time zone $5::text)::date`
  const volume = (expr: string, limit = 20) =>
    q<KeyCount>(
      `select ${expr} as key, count(*) as n from tickets t
        where t.tenant_id = $1 and t.created_at >= $2 and t.created_at < $3 and ${typeCond}
        group by 1 order by n desc, key limit ${limit}`,
      base.slice(0, 4)
    )

  const [raised, resolved, byType, byPriority, byCategory, bySource, slaRows, times, ageing, agents, unassigned, groups, outcomes, totals] =
    await Promise.all([
      q<KeyCount>(
        `select ${bucket("t.created_at")}::text as key, count(*) as n from tickets t
          where t.tenant_id = $1 and t.created_at >= $2 and t.created_at < $3 and ${typeCond} group by 1`,
        base
      ),
      q<KeyCount>(
        `select ${bucket("t.resolved_at")}::text as key, count(*) as n from tickets t
          where t.tenant_id = $1 and t.resolved_at >= $2 and t.resolved_at < $3 and ${typeCond} group by 1`,
        base
      ),
      volume("t.ticket_type"),
      volume("t.priority"),
      volume("coalesce(t.category, '(none)')", 15),
      volume("t.source"),
      q<SlaRow>(
        `select s.kind, t.priority, count(*) filter (where s.status = 'met') as met, count(*) filter (where s.status = 'breached') as breached
           from ticket_sla s join tickets t on t.id = s.ticket_id and t.tenant_id = s.tenant_id
          where s.tenant_id = $1 and s.kind in ('response', 'resolution') and s.status in ('met', 'breached')
            and s.stopped_at >= $2 and s.stopped_at < $3 and ${typeCond}
          group by 1, 2`,
        base.slice(0, 4)
      ),
      q<{ priority: string; resolved: number; mttr: number | null; responded: number; mtfr: number | null }>(
        `select t.priority,
                count(*) filter (where t.resolved_at >= $2 and t.resolved_at < $3) as resolved,
                avg(extract(epoch from t.resolved_at - t.created_at) / 60) filter (where t.resolved_at >= $2 and t.resolved_at < $3) as mttr,
                count(*) filter (where t.first_response_at >= $2 and t.first_response_at < $3) as responded,
                avg(extract(epoch from t.first_response_at - t.created_at) / 60) filter (where t.first_response_at >= $2 and t.first_response_at < $3) as mtfr
           from tickets t
          where t.tenant_id = $1 and ${typeCond}
            and ((t.resolved_at >= $2 and t.resolved_at < $3) or (t.first_response_at >= $2 and t.first_response_at < $3))
          group by 1`,
        base.slice(0, 4)
      ),
      q<{ bucket: number; n: number }>(
        `select width_bucket((extract(epoch from now() - t.created_at) / 3600)::float8, $3::float8[]) as bucket, count(*) as n
           from tickets t where t.tenant_id = $1 and ${OPEN} and ($2::text is null or t.ticket_type = $2::text)
          group by 1`,
        [actor.tenantId, type, [...AGE_THRESHOLDS_HOURS]]
      ),
      q<{ id: string; name: string; open: number; resolved: number }>(
        `select u.id, coalesce(nullif(u.full_name, ''), u.email) as name,
                count(*) filter (where ${OPEN}) as open,
                count(*) filter (where t.resolved_at >= $2 and t.resolved_at < $3) as resolved
           from tickets t join users u on u.id = t.assignee_id
          where t.tenant_id = $1 and ${typeCond} and (${OPEN} or (t.resolved_at >= $2 and t.resolved_at < $3))
          group by u.id, 2
          order by open desc, resolved desc, name
          limit 50`,
        base.slice(0, 4)
      ),
      q1<{ n: number }>(`select count(*) as n from tickets t where t.tenant_id = $1 and ${OPEN} and t.status <> 'draft' and t.assignee_id is null and ($2::text is null or t.ticket_type = $2::text)`, [
        actor.tenantId,
        type,
      ]),
      q<{ id: string | null; name: string; open: number; resolved: number }>(
        `select g.id, coalesce(g.name, '(no group)') as name,
                count(*) filter (where ${OPEN}) as open,
                count(*) filter (where t.resolved_at >= $2 and t.resolved_at < $3) as resolved
           from tickets t left join groups g on g.id = t.assignment_group_id and g.tenant_id = t.tenant_id
          where t.tenant_id = $1 and ${typeCond} and (${OPEN} or (t.resolved_at >= $2 and t.resolved_at < $3))
          group by g.id, 2
          order by open desc, resolved desc, name
          limit 50`,
        base.slice(0, 4)
      ),
      q<{ outcome: string; n: number }>(
        `select t.change_outcome as outcome, count(*) as n from tickets t
          where t.tenant_id = $1 and t.ticket_type = 'change' and t.change_outcome is not null
            and t.closed_at >= $2 and t.closed_at < $3
          group by 1`,
        base.slice(0, 3)
      ),
      q1<{ raised: number; resolved: number; open: number }>(
        `select count(*) filter (where t.created_at >= $2 and t.created_at < $3) as raised,
                count(*) filter (where t.resolved_at >= $2 and t.resolved_at < $3) as resolved,
                count(*) filter (where ${OPEN}) as open
           from tickets t where t.tenant_id = $1 and ${typeCond}`,
        base.slice(0, 4)
      ),
    ])

  const keys = seriesKeys(range)
  const raisedSeries = fillSeries(keys, raised)
  const resolvedSeries = fillSeries(keys, resolved)
  const sla = summarizeSla(slaRows, PRIORITIES)
  const byPri = (p: string) => times.find((r) => r.priority === p)
  return {
    type,
    totals: { raised: totals?.raised ?? 0, resolved: totals?.resolved ?? 0, open: totals?.open ?? 0 },
    series: keys.map((key, i) => ({ key, raised: raisedSeries[i].n, resolved: resolvedSeries[i].n })),
    volume: { byType, byPriority, byCategory, bySource },
    sla,
    times: {
      byPriority: [...PRIORITIES].reverse().map((p) => ({
        priority: p,
        resolved: byPri(p)?.resolved ?? 0,
        mttr: byPri(p)?.mttr ?? null,
        responded: byPri(p)?.responded ?? 0,
        mtfr: byPri(p)?.mtfr ?? null,
      })),
      overall: {
        resolved: times.reduce((s, r) => s + r.resolved, 0),
        mttr: weightedMean(times.map((r) => ({ n: r.resolved, mean: r.mttr }))),
        responded: times.reduce((s, r) => s + r.responded, 0),
        mtfr: weightedMean(times.map((r) => ({ n: r.responded, mean: r.mtfr }))),
      },
    },
    ageing: ageingBuckets(ageing),
    workload: { agents, unassigned: unassigned?.n ?? 0, groups },
    changes: changeSuccess(outcomes),
    resolvedRate: percent(totals?.resolved ?? 0, totals?.raised ?? 0),
  }
}

export type TicketReport = Awaited<ReturnType<typeof ticketReport>>
