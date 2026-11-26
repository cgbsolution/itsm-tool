/**
 * Background work of the endpoint module. Wire it up once in
 * src/lib/jobs/handlers.ts:  registerEndpointJobs()
 *
 *   deployments.start   every 60 s   scheduled deployments whose time / maintenance window has come
 *   patch.policies      every 300 s  policy auto-approval, and scheduled policy deployments
 *   agents.expire_jobs  every 300 s  jobs stuck with an agent for 3 h, or queued past expires_at
 */
import { q, q1, tx, type Db } from "@/lib/db"
import { registerHandler, registerSchedule } from "@/lib/jobs/worker"
import { audit } from "@/lib/audit"
import { log } from "@/lib/log"
import { formatDateTime } from "@/lib/format"
import { overlapsBlackout, windowsFor } from "@/lib/itsm/windows"
import { applyAutoApproval, maybeCompleteDeployment } from "@/lib/endpoints/core"
import { runDeploymentsStart, startDeployment } from "@/lib/endpoints/deployments"
import { dueSlot } from "@/lib/endpoints/planning"
import type { RebootBehavior } from "@/lib/endpoints/vocab"

export function registerEndpointJobs() {
  registerHandler("deployments.start", async () => {
    await runDeploymentsStart()
  })
  registerHandler("patch.policies", async () => {
    await runPatchPolicies()
  })
  registerHandler("agents.expire_jobs", async () => {
    await expireAgentJobs()
  })
  registerSchedule("deployments.start", 60)
  registerSchedule("patch.policies", 300)
  registerSchedule("agents.expire_jobs", 300)
}

/* ── agents.expire_jobs ────────────────────────────────────────────────── */

export async function expireAgentJobs(): Promise<number> {
  const rows = await q<{ tenant_id: string; deployment_id: string | null }>(
    `update agent_jobs set status = 'expired', finished_at = now()
      where (status in ('dispatched', 'running') and coalesce(started_at, dispatched_at, created_at) < now() - interval '3 hours')
         or (status = 'queued' and expires_at is not null and expires_at < now())
      returning tenant_id, deployment_id`
  )
  const deployments = new Map<string, string>()
  for (const r of rows) if (r.deployment_id) deployments.set(r.deployment_id, r.tenant_id)
  for (const [deploymentId, tenantId] of deployments) {
    await tx((db) => maybeCompleteDeployment(db, tenantId, deploymentId)).catch((err) => log.error("agents.complete_failed", { deployment_id: deploymentId, err }))
  }
  if (rows.length) log.info("agents.jobs_expired", { count: rows.length })
  return rows.length
}

/* ── patch.policies ────────────────────────────────────────────────────── */

type PolicyRow = {
  id: string
  tenant_id: string
  name: string
  device_group_id: string | null
  schedule_days: number[]
  schedule_time: string
  maintenance_window_id: string | null
  reboot_behavior: RebootBehavior
  last_run_at: Date | null
  created_at: Date
  tz: string
}

export async function runPatchPolicies(now = new Date()): Promise<{ approved: number; deployments: number }> {
  let approved = 0
  let deployments = 0

  const tenants = await q<{ tenant_id: string }>(
    "select distinct tenant_id from patch_policies where is_active and cardinality(auto_approve_classifications) > 0"
  )
  for (const t of tenants) {
    try {
      approved += (await tx((db) => applyAutoApproval(db, t.tenant_id))).length
    } catch (err) {
      log.error("patch.auto_approve_failed", { tenant_id: t.tenant_id, err })
    }
  }

  const policies = await q<PolicyRow>(
    `select p.id, p.tenant_id, p.name, p.device_group_id, p.schedule_days, p.schedule_time::text as schedule_time, p.maintenance_window_id,
            p.reboot_behavior, p.last_run_at, p.created_at, coalesce(s.timezone, 'UTC') as tz
       from patch_policies p left join tenant_settings s on s.tenant_id = p.tenant_id
      where p.is_active and cardinality(p.schedule_days) > 0`
  )
  for (const p of policies) {
    const slot = dueSlot({ days: p.schedule_days, time: p.schedule_time, tz: p.tz, lastRunAt: p.last_run_at, createdAt: p.created_at, now })
    if (!slot) continue
    try {
      const made = await tx(async (db) => {
        // claim the slot (one run per slot even with several app replicas)
        const claimed = await q1<{ id: string }>(
          "update patch_policies set last_run_at = $3 where id = $1 and tenant_id = $2 and (last_run_at is null or last_run_at < $4) returning id",
          [p.id, p.tenant_id, now, slot],
          db
        )
        if (!claimed) return false
        return runPolicyDeployment(db, p, slot, now)
      })
      if (made) deployments++
    } catch (err) {
      log.error("patch.policy_run_failed", { policy_id: p.id, err })
    }
  }
  return { approved, deployments }
}

/** Creates (and starts, or schedules into the policy's window) a deployment of the group's missing approved patches. */
async function runPolicyDeployment(db: Db, p: PolicyRow, slot: Date, now: Date): Promise<boolean> {
  const devices = await q<{ id: string }>(
    `select id from devices where tenant_id = $1 and status = 'active' ${p.device_group_id ? "and group_id = $2" : ""} order by hostname`,
    p.device_group_id ? [p.tenant_id, p.device_group_id] : [p.tenant_id],
    db
  )
  const deviceIds = devices.map((d) => d.id)
  const patches = deviceIds.length
    ? await q<{ patch_id: string }>(
        `select distinct dp.patch_id
           from device_patches dp
           join patches pa on pa.id = dp.patch_id and pa.tenant_id = $1 and pa.approval = 'approved'
          where dp.device_id = any($2::uuid[]) and dp.state in ('missing', 'failed')`,
        [p.tenant_id, deviceIds],
        db
      )
    : []
  if (!patches.length) {
    log.info("patch.policy_nothing_to_do", { policy_id: p.id })
    return false
  }
  const windows = await windowsFor(p.tenant_id, "patches", db)
  const frozen = !!overlapsBlackout(windows, now, new Date(now.getTime() + 60_000))
  const scheduled = !!p.maintenance_window_id || frozen
  const row = await q1<{ id: string }>(
    `insert into patch_deployments (tenant_id, name, description, status, patch_ids, target_device_ids, target_group_ids, scheduled_at,
                                    maintenance_window_id, reboot_behavior, policy_id)
     values ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7::uuid[], $8, $9, $10, $11) returning id`,
    [
      p.tenant_id,
      `${p.name} · ${formatDateTime(slot, p.tz)}`,
      "Created by the patch policy schedule",
      scheduled ? "scheduled" : "running",
      patches.map((x) => x.patch_id),
      p.device_group_id ? [] : deviceIds,
      p.device_group_id ? [p.device_group_id] : [],
      scheduled ? now : null,
      p.maintenance_window_id,
      p.reboot_behavior,
      p.id,
    ],
    db
  )
  const jobs = scheduled ? 0 : (await startDeployment(db, p.tenant_id, row!.id)).jobs
  await audit(
    {
      tenantId: p.tenant_id,
      actor: null,
      action: "patch.policy_run",
      entityType: "patch_deployment",
      entityId: row!.id,
      summary: `Patch policy ${p.name} created a deployment of ${patches.length} patch${patches.length === 1 ? "" : "es"}`,
      data: { policy_id: p.id, slot: slot.toISOString(), jobs, scheduled },
    },
    db
  )
  return true
}
