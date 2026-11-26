/**
 * Low-level endpoint helpers shared by the agent API, the admin services and
 * the background jobs. Every function takes the db (or transaction) to run
 * in and a tenant id, and filters on it.
 */
import { q, q1, exec, type Db } from "@/lib/db"
import { AppError, notFound } from "@/lib/errors"
import { audit } from "@/lib/audit"
import { config } from "@/lib/config"
import { log } from "@/lib/log"
import { planInstallJobs, type InstallPayload, type PlanPatch } from "@/lib/endpoints/planning"
import type { JobKind, RebootBehavior } from "@/lib/endpoints/vocab"

/** How long a queued job waits for an offline device before it expires. */
const DEFAULT_EXPIRY_HOURS: Record<JobKind, number> = {
  inventory: 24,
  scan: 24,
  install_patches: 24 * 7,
  run_script: 24,
  reboot: 4,
  update_agent: 24 * 7,
}

export type QueueJobInput = {
  tenantId: string
  deviceId: string
  kind: JobKind
  payload: Record<string, unknown>
  deploymentId?: string | null
  createdBy: string | null
  notBefore?: Date | null
  expiresAt?: Date | null
}

/** Queues work for a device's agent. The device must be active and in the tenant. */
export async function queueAgentJob(db: Db, input: QueueJobInput): Promise<string> {
  const d = await q1<{ status: string }>("select status from devices where id = $1 and tenant_id = $2", [input.deviceId, input.tenantId], db)
  if (!d) throw notFound("Device not found")
  if (d.status !== "active") throw new AppError("This device is retired")
  const expires = input.expiresAt ?? new Date((input.notBefore ?? new Date()).getTime() + DEFAULT_EXPIRY_HOURS[input.kind] * 3600_000)
  const row = await q1<{ id: string }>(
    `insert into agent_jobs (tenant_id, device_id, kind, payload, deployment_id, created_by, not_before, expires_at)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, now()), $8)
     returning id`,
    [input.tenantId, input.deviceId, input.kind, JSON.stringify(input.payload), input.deploymentId ?? null, input.createdBy, input.notBefore ?? null, expires],
    db
  )
  return row!.id
}

/**
 * Marks a running deployment completed once none of its jobs is queued,
 * dispatched or running. Locks the deployment row first so two devices
 * finishing at the same moment cannot both miss the last job.
 */
export async function maybeCompleteDeployment(db: Db, tenantId: string, deploymentId: string): Promise<boolean> {
  const dep = await q1<{ id: string }>(
    "select id from patch_deployments where id = $1 and tenant_id = $2 and status = 'running' for update",
    [deploymentId, tenantId],
    db
  )
  if (!dep) return false
  const n = await exec(
    `update patch_deployments set status = 'completed', completed_at = now()
      where id = $1 and tenant_id = $2 and status = 'running'
        and not exists (select 1 from agent_jobs j where j.deployment_id = $1 and j.tenant_id = $2 and j.status in ('queued', 'dispatched', 'running'))`,
    [deploymentId, tenantId],
    db
  )
  return n > 0
}

/**
 * Auto-approval: pending patches whose classification a covering active
 * policy auto-approves, once first seen longer ago than the policy's delay.
 * "Covering" means the policy's device group (or every device) contains an
 * active device that is missing the patch. Optionally limited to one device.
 */
export async function applyAutoApproval(db: Db, tenantId: string, opts: { deviceId?: string } = {}): Promise<{ id: string; title: string }[]> {
  const params: unknown[] = [tenantId]
  let deviceFilter = ""
  if (opts.deviceId) {
    params.push(opts.deviceId)
    deviceFilter = "and dp.device_id = $2"
  }
  const rows = await q<{ id: string; title: string }>(
    `with candidates as (
       select distinct p.id
         from patches p
         join device_patches dp on dp.patch_id = p.id and dp.state in ('missing', 'failed')
         join devices d on d.id = dp.device_id and d.tenant_id = p.tenant_id and d.status = 'active'
         join patch_policies pol on pol.tenant_id = p.tenant_id and pol.is_active
              and (pol.device_group_id is null or pol.device_group_id = d.group_id)
              and p.classification = any(pol.auto_approve_classifications)
              and p.first_seen_at <= now() - make_interval(days => pol.auto_approve_delay_days)
        where p.tenant_id = $1 and p.approval = 'pending' ${deviceFilter}
     )
     update patches p set approval = 'approved', approved_by = null, approved_at = now(), updated_at = now()
       from candidates c
      where p.id = c.id and p.tenant_id = $1 and p.approval = 'pending'
     returning p.id, p.title`,
    params,
    db
  )
  if (rows.length) {
    await audit(
      {
        tenantId,
        actor: null,
        action: "patch.auto_approved",
        entityType: "patch",
        entityId: rows.length === 1 ? rows[0].id : null,
        summary: `Auto-approved ${rows.length} patch${rows.length === 1 ? "" : "es"} by policy`,
        data: { count: rows.length, patch_ids: rows.slice(0, 200).map((r) => r.id), titles: rows.slice(0, 20).map((r) => r.title) },
      },
      db
    )
    log.info("patch.auto_approved", { tenant_id: tenantId, count: rows.length })
  }
  return rows
}

/** Retries a unit of work on deadlock / serialization failure. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (i >= attempts || (code !== "40P01" && code !== "40001")) throw err
      await new Promise((r) => setTimeout(r, 50 * i + Math.random() * 100))
    }
  }
}

/** Patches (with offline package info) by id, for job planning. */
async function loadPlanPatches(db: Db, tenantId: string, patchIds: string[]): Promise<Map<string, PlanPatch>> {
  const rows = await q<{ id: string; external_id: string; kb: string | null; title: string; approval: string; file_name: string | null; sha256: string | null }>(
    `select p.id, p.external_id, p.kb, p.title, p.approval, f.file_name, f.sha256
       from patches p
       left join files f on f.id = p.package_file_id and f.tenant_id = p.tenant_id and f.storage_key is not null and f.scan_status <> 'infected'
      where p.tenant_id = $1 and p.id = any($2::uuid[])`,
    [tenantId, patchIds],
    db
  )
  return new Map(rows.map((r) => [r.id, { id: r.id, external_id: r.external_id, kb: r.kb, title: r.title, approval: r.approval, package: r.file_name ? { file_name: r.file_name, sha256: r.sha256 } : null }]))
}

/**
 * Builds install_patches payloads: per active target device, the approved
 * patches it is missing (limited to `onlyPatchIds` when given).
 */
export async function planInstalls(
  db: Db,
  tenantId: string,
  opts: { deviceIds: string[]; onlyPatchIds?: string[] | null; reboot: RebootBehavior }
): Promise<{ deviceId: string; payload: InstallPayload }[]> {
  if (!opts.deviceIds.length) return []
  const params: unknown[] = [tenantId, opts.deviceIds]
  let patchFilter = ""
  if (opts.onlyPatchIds && opts.onlyPatchIds.length) {
    params.push(opts.onlyPatchIds)
    patchFilter = "and dp.patch_id = any($3::uuid[])"
  }
  const missing = await q<{ device_id: string; patch_id: string }>(
    `select dp.device_id, dp.patch_id
       from device_patches dp
       join devices d on d.id = dp.device_id and d.tenant_id = $1 and d.status = 'active'
       join patches p on p.id = dp.patch_id and p.tenant_id = $1 and p.approval = 'approved'
      where dp.device_id = any($2::uuid[]) and dp.state in ('missing', 'failed') ${patchFilter}`,
    params,
    db
  )
  if (!missing.length) return []
  const patches = await loadPlanPatches(db, tenantId, [...new Set(missing.map((m) => m.patch_id))])
  return planInstallJobs({ deviceIds: opts.deviceIds, missing, patches, onlyPatchIds: opts.onlyPatchIds, reboot: opts.reboot, appUrl: config.appUrl() })
}

/** Time zone of a tenant (tenant_settings.timezone, default UTC). */
export async function tenantTimeZone(db: Db, tenantId: string): Promise<string> {
  const row = await q1<{ timezone: string | null }>("select timezone from tenant_settings where tenant_id = $1", [tenantId], db)
  return row?.timezone || "UTC"
}
