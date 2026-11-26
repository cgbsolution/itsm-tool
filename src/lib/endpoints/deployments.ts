/**
 * Patch deployments: create (now, at a time, or in the next maintenance
 * window), start (one install_patches job per target device with the approved
 * patches it is missing), cancel, and "install now" for a single device.
 */
import { z } from "zod"
import { q, q1, exec, tx, isUuid, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { actorId } from "@/lib/auth/system"
import { AppError, notFound } from "@/lib/errors"
import { parse } from "@/lib/validate"
import { audit } from "@/lib/audit"
import { humanize } from "@/lib/itsm/vocab"
import { insideMaintenance, nextMaintenanceStart, occurrences, overlapsBlackout, windowsFor, type WindowRow } from "@/lib/itsm/windows"
import { log } from "@/lib/log"
import { need } from "@/lib/endpoints/service"
import { planInstalls, queueAgentJob } from "@/lib/endpoints/core"
import { REBOOT_BEHAVIORS, type RebootBehavior } from "@/lib/endpoints/vocab"

const auditActor = (actor: Actor) => (actor.isSystem ? null : { id: actor.id, email: actor.email })
const uuidList = (max: number) => z.array(z.string().refine((v) => isUuid(v), "Invalid reference")).max(max)

export const deploymentSchema = z.object({
  name: z.string().trim().min(3, "Give the deployment a name of at least 3 characters").max(200, "Keep the name under 200 characters"),
  description: z.string().trim().max(5000).nullish(),
  patchIds: uuidList(2000).min(1, "Select at least one approved patch"),
  targetGroupIds: uuidList(200),
  targetDeviceIds: uuidList(10_000),
  schedule: z.enum(["now", "at", "window"]),
  scheduledAt: z.date().nullish(),
  maintenanceWindowId: z.string().refine((v) => isUuid(v), "Invalid maintenance window").nullish(),
  rebootBehavior: z.enum(REBOOT_BEHAVIORS),
  changeNumber: z.string().trim().max(40).nullish(),
})
export type DeploymentInput = z.input<typeof deploymentSchema>

/** A change may be implemented by a deployment while it is scheduled or implementing. */
export async function resolveChange(db: Db, tenantId: string, number: string): Promise<string> {
  const c = await q1<{ id: string; number: string; status: string }>(
    "select id, number, status from tickets where tenant_id = $1 and upper(number) = upper($2) and ticket_type = 'change'",
    [tenantId, number.trim()],
    db
  )
  if (!c) throw new AppError(`There is no change ${number.trim().toUpperCase()} in this tenant`)
  if (c.status !== "scheduled" && c.status !== "implementing") {
    throw new AppError(`${c.number} is ${humanize(c.status).toLowerCase()}. Link a change that is scheduled or implementing.`)
  }
  return c.id
}

function activeBlackout(windows: WindowRow[], at: Date): WindowRow | null {
  return overlapsBlackout(windows, at, new Date(at.getTime() + 60_000))
}

/** End of the occurrence of a maintenance window that contains `at`. */
function windowEnd(windows: WindowRow[], windowId: string, at: Date): Date | null {
  const w = windows.find((x) => x.id === windowId)
  if (!w) return null
  return occurrences(w, at, new Date(at.getTime() + 1), 1)[0]?.end ?? null
}

export async function createDeployment(actor: Actor, raw: DeploymentInput): Promise<{ id: string; status: string; jobs: number }> {
  need(actor, "patch.deploy")
  const input = parse(deploymentSchema, raw)
  const patchIds = [...new Set(input.patchIds)]
  const groupIds = [...new Set(input.targetGroupIds)]
  const deviceIds = [...new Set(input.targetDeviceIds)]
  if (!groupIds.length && !deviceIds.length) throw new AppError("Choose at least one device group or device to deploy to")

  return tx(async (db) => {
    const tenantId = actor.tenantId
    const patches = await q<{ id: string; title: string; approval: string }>("select id, title, approval from patches where tenant_id = $1 and id = any($2::uuid[])", [tenantId, patchIds], db)
    if (patches.length !== patchIds.length) throw new AppError("Some selected patches do not exist")
    const notApproved = patches.filter((p) => p.approval !== "approved")
    if (notApproved.length) throw new AppError(`Only approved patches can be deployed: ${notApproved[0].title} is ${notApproved[0].approval}`)
    if (groupIds.length) {
      const n = await q1<{ n: number }>("select count(*) as n from device_groups where tenant_id = $1 and id = any($2::uuid[])", [tenantId, groupIds], db)
      if ((n?.n ?? 0) !== groupIds.length) throw new AppError("Some selected device groups do not exist")
    }
    if (deviceIds.length) {
      const n = await q1<{ n: number }>("select count(*) as n from devices where tenant_id = $1 and status = 'active' and id = any($2::uuid[])", [tenantId, deviceIds], db)
      if ((n?.n ?? 0) !== deviceIds.length) throw new AppError("Some selected devices do not exist or are retired")
    }
    const changeId = input.changeNumber ? await resolveChange(db, tenantId, input.changeNumber) : null

    const windows = await windowsFor(tenantId, "patches", db)
    const now = new Date()
    let status: "running" | "scheduled" = "scheduled"
    let scheduledAt: Date | null = null
    let windowId: string | null = null
    if (input.schedule === "now") {
      const freeze = activeBlackout(windows, now)
      if (freeze) throw new AppError(`The change freeze "${freeze.name}" is in effect. Schedule the deployment for after it.`)
      status = "running"
    } else if (input.schedule === "at") {
      if (!input.scheduledAt) throw new AppError("Choose when the deployment starts")
      if (input.scheduledAt.getTime() < now.getTime() - 60_000) throw new AppError("Choose a start time in the future")
      scheduledAt = input.scheduledAt
    } else {
      if (!input.maintenanceWindowId) throw new AppError("Choose a maintenance window")
      const w = windows.find((x) => x.id === input.maintenanceWindowId && x.kind === "maintenance")
      if (!w) throw new AppError("That maintenance window does not exist or does not apply to patches")
      scheduledAt = nextMaintenanceStart(windows, now, w.id)
      if (!scheduledAt) throw new AppError(`${w.name} has no upcoming occurrence`)
      windowId = w.id
    }

    const row = await q1<{ id: string }>(
      `insert into patch_deployments (tenant_id, name, description, status, patch_ids, target_device_ids, target_group_ids, scheduled_at,
                                      maintenance_window_id, reboot_behavior, change_id, created_by)
       values ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7::uuid[], $8, $9, $10, $11, $12) returning id`,
      [tenantId, input.name, input.description || null, status, patchIds, deviceIds, groupIds, scheduledAt, windowId, input.rebootBehavior, changeId, actorId(actor)],
      db
    )
    const id = row!.id
    let jobs = 0
    let finalStatus: string = status
    if (status === "running") {
      const r = await startDeployment(db, tenantId, id)
      jobs = r.jobs
      finalStatus = r.status
    }
    await audit(
      {
        tenantId,
        actor: auditActor(actor),
        action: "patch.deployment_created",
        entityType: "patch_deployment",
        entityId: id,
        summary: `Created patch deployment ${input.name} (${patchIds.length} patch${patchIds.length === 1 ? "" : "es"}, ${input.schedule === "now" ? "started now" : `scheduled ${scheduledAt?.toISOString()}`})`,
        data: { patch_ids: patchIds, target_group_ids: groupIds, target_device_ids: deviceIds.slice(0, 500), change_id: changeId, reboot: input.rebootBehavior, jobs },
      },
      db
    )
    return { id, status: finalStatus, jobs }
  })
}

/**
 * Starts a deployment: one install_patches job per active target device that
 * is missing at least one of its (still approved) patches. A deployment with
 * nothing to install completes at once.
 */
export async function startDeployment(db: Db, tenantId: string, deploymentId: string, opts: { expiresAt?: Date | null } = {}): Promise<{ jobs: number; status: string }> {
  const dep = await q1<{ id: string; status: string; patch_ids: string[]; target_device_ids: string[]; target_group_ids: string[]; reboot_behavior: RebootBehavior; created_by: string | null }>(
    "select id, status, patch_ids, target_device_ids, target_group_ids, reboot_behavior, created_by from patch_deployments where id = $1 and tenant_id = $2 for update",
    [deploymentId, tenantId],
    db
  )
  if (!dep) throw notFound("Deployment not found")
  if (dep.status !== "scheduled" && dep.status !== "running" && dep.status !== "draft") return { jobs: 0, status: dep.status }
  const already = await q1<{ n: number }>("select count(*) as n from agent_jobs where deployment_id = $1 and tenant_id = $2", [dep.id, tenantId], db)
  if ((already?.n ?? 0) > 0) return { jobs: 0, status: dep.status }

  const devices = await q<{ id: string }>(
    "select id from devices where tenant_id = $1 and status = 'active' and (id = any($2::uuid[]) or group_id = any($3::uuid[])) order by hostname, id",
    [tenantId, dep.target_device_ids, dep.target_group_ids],
    db
  )
  const plans = await planInstalls(db, tenantId, { deviceIds: devices.map((d) => d.id), onlyPatchIds: dep.patch_ids, reboot: dep.reboot_behavior })
  if (plans.length) {
    const expires = opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000)
    await exec(
      `insert into agent_jobs (tenant_id, device_id, kind, payload, deployment_id, created_by, expires_at)
       select $1, x.device_id, 'install_patches', x.payload, $2, $3, $4
         from unnest($5::uuid[], $6::jsonb[]) as x(device_id, payload)`,
      [tenantId, dep.id, dep.created_by, expires, plans.map((p) => p.deviceId), plans.map((p) => JSON.stringify(p.payload))],
      db
    )
  }
  const status = plans.length ? "running" : "completed"
  await exec(
    `update patch_deployments set status = $3, started_at = coalesce(started_at, now()), completed_at = case when $3 = 'completed' then now() else null end
      where id = $1 and tenant_id = $2`,
    [dep.id, tenantId, status],
    db
  )
  return { jobs: plans.length, status }
}

export async function cancelDeployment(actor: Actor, deploymentId: string): Promise<{ cancelledJobs: number }> {
  need(actor, "patch.deploy")
  if (!isUuid(deploymentId)) throw notFound("Deployment not found")
  return tx(async (db) => {
    const dep = await q1<{ name: string; status: string }>("select name, status from patch_deployments where id = $1 and tenant_id = $2 for update", [deploymentId, actor.tenantId], db)
    if (!dep) throw notFound("Deployment not found")
    if (!["draft", "scheduled", "running"].includes(dep.status)) throw new AppError(`This deployment is already ${dep.status}`)
    // jobs the agent has not started; a dispatched job gets 409 when the agent reports on it
    const n = await exec(
      "update agent_jobs set status = 'cancelled', finished_at = now() where deployment_id = $1 and tenant_id = $2 and status in ('queued', 'dispatched')",
      [deploymentId, actor.tenantId],
      db
    )
    await exec("update patch_deployments set status = 'cancelled', completed_at = now() where id = $1 and tenant_id = $2", [deploymentId, actor.tenantId], db)
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "patch.deployment_cancelled", entityType: "patch_deployment", entityId: deploymentId, summary: `Cancelled patch deployment ${dep.name}`, data: { cancelled_jobs: n } },
      db
    )
    return { cancelledJobs: n }
  })
}

/** "Install approved missing patches now" for one device (no deployment record). */
export async function installApprovedNow(actor: Actor, deviceId: string, reboot: RebootBehavior): Promise<{ jobId: string; patches: number }> {
  need(actor, "endpoint.manage")
  if (!isUuid(deviceId)) throw notFound("Device not found")
  if (!(REBOOT_BEHAVIORS as readonly string[]).includes(reboot)) throw new AppError("Choose a reboot behaviour")
  return tx(async (db) => {
    const d = await q1<{ id: string; hostname: string; status: string }>("select id, hostname, status from devices where id = $1 and tenant_id = $2", [deviceId, actor.tenantId], db)
    if (!d) throw notFound("Device not found")
    if (d.status !== "active") throw new AppError("This device is retired")
    const windows = await windowsFor(actor.tenantId, "patches", db)
    const freeze = activeBlackout(windows, new Date())
    if (freeze) throw new AppError(`The change freeze "${freeze.name}" is in effect`)
    const [plan] = await planInstalls(db, actor.tenantId, { deviceIds: [d.id], reboot })
    if (!plan) throw new AppError("No approved patches are missing on this device")
    const jobId = await queueAgentJob(db, { tenantId: actor.tenantId, deviceId: d.id, kind: "install_patches", payload: plan.payload, createdBy: actorId(actor) })
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "endpoint.install_requested",
        entityType: "device",
        entityId: d.id,
        summary: `Requested installation of ${plan.payload.patches.length} approved patch${plan.payload.patches.length === 1 ? "" : "es"} on ${d.hostname}`,
        data: { job_id: jobId, patch_ids: plan.payload.patches.map((p) => p.patch_id), reboot },
      },
      db
    )
    return { jobId, patches: plan.payload.patches.length }
  })
}

/* ── background: scheduled deployments ─────────────────────────────────── */

/**
 * Starts scheduled deployments whose time has come. Deployments tied to a
 * maintenance window start only inside it (their jobs expire when it ends);
 * nothing starts during a change freeze.
 */
export async function runDeploymentsStart(now = new Date()): Promise<number> {
  const due = await q<{ id: string; tenant_id: string }>(
    `select id, tenant_id from patch_deployments
      where status = 'scheduled' and (maintenance_window_id is not null or scheduled_at is null or scheduled_at <= now())
      order by scheduled_at nulls first limit 500`
  )
  const windowsByTenant = new Map<string, WindowRow[]>()
  let started = 0
  for (const d of due) {
    try {
      let windows = windowsByTenant.get(d.tenant_id)
      if (!windows) windowsByTenant.set(d.tenant_id, (windows = await windowsFor(d.tenant_id, "patches")))
      const w = windows
      await tx(async (db) => {
        const dep = await q1<{ id: string; status: string; scheduled_at: Date | null; maintenance_window_id: string | null }>(
          "select id, status, scheduled_at, maintenance_window_id from patch_deployments where id = $1 and tenant_id = $2 for update skip locked",
          [d.id, d.tenant_id],
          db
        )
        if (!dep || dep.status !== "scheduled") return
        if (activeBlackout(w, now)) return
        if (dep.maintenance_window_id) {
          const wid = dep.maintenance_window_id
          if (!insideMaintenance(w, now, wid)) {
            const next = nextMaintenanceStart(w, now, wid)
            if (next && (!dep.scheduled_at || next.getTime() !== new Date(dep.scheduled_at).getTime())) {
              await exec("update patch_deployments set scheduled_at = $3 where id = $1 and tenant_id = $2", [dep.id, d.tenant_id, next], db)
            }
            return
          }
          await startDeployment(db, d.tenant_id, dep.id, { expiresAt: windowEnd(w, wid, now) })
        } else {
          if (dep.scheduled_at && new Date(dep.scheduled_at).getTime() > now.getTime()) return
          await startDeployment(db, d.tenant_id, dep.id)
        }
        started++
      })
    } catch (err) {
      log.error("patch.deployment_start_failed", { deployment_id: d.id, err })
    }
  }
  return started
}
