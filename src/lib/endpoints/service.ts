/**
 * Endpoint and patch services for people (pages, server actions, API):
 * enrolment tokens, device groups, device actions, scripts, patch approval,
 * offline packages and patch policies. Every function re-checks the actor's
 * permission and filters on the actor's tenant.
 */
import { z } from "zod"
import { q, q1, exec, tx, isUuid, isUniqueViolation, pool, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import type { Permission } from "@/lib/auth/permissions"
import { actorId } from "@/lib/auth/system"
import { AppError, forbidden, notFound } from "@/lib/errors"
import { parse } from "@/lib/validate"
import { audit } from "@/lib/audit"
import { randomToken, sha256Hex } from "@/lib/crypto"
import { saveBuffer } from "@/lib/files/storage"
import { maybeCompleteDeployment, queueAgentJob } from "@/lib/endpoints/core"
import { parseTimeOfDay } from "@/lib/endpoints/planning"
import { APPROVALS, CLASSIFICATIONS, REBOOT_BEHAVIORS, SHELLS, shellsFor, type Approval } from "@/lib/endpoints/vocab"

export { queueAgentJob } from "@/lib/endpoints/core"

export function need(actor: Actor, perm: Permission) {
  if (!actor.permissions.has(perm)) throw forbidden()
}

const auditActor = (actor: Actor) => (actor.isSystem ? null : { id: actor.id, email: actor.email })
const ref = (msg = "Invalid reference") => z.string().refine((v) => isUuid(v), msg)

async function loadDevice(db: Db, actor: Actor, deviceId: string) {
  if (!isUuid(deviceId)) throw notFound("Device not found")
  const d = await q1<{ id: string; hostname: string; os_family: string; status: string; group_id: string | null }>(
    "select id, hostname, os_family, status, group_id from devices where id = $1 and tenant_id = $2",
    [deviceId, actor.tenantId],
    db
  )
  if (!d) throw notFound("Device not found")
  return d
}

async function assertGroup(db: Db, tenantId: string, groupId: string) {
  const g = await q1("select 1 from device_groups where id = $1 and tenant_id = $2", [groupId, tenantId], db)
  if (!g) throw new AppError("That device group does not exist")
}

/* ── enrolment tokens ──────────────────────────────────────────────────── */

export const tokenSchema = z.object({
  name: z.string().trim().min(2, "Give the token a name of at least 2 characters").max(100, "Keep the name under 100 characters"),
  groupId: ref().nullish(),
  expiresAt: z.date().nullish(),
  maxUses: z.number().int().min(1, "Max uses must be at least 1").max(1_000_000).nullish(),
})

/** Creates an enrolment token. The plaintext is returned once and never stored. */
export async function createEnrollmentToken(actor: Actor, raw: z.input<typeof tokenSchema>): Promise<{ id: string; token: string; prefix: string }> {
  need(actor, "endpoint.manage")
  const input = parse(tokenSchema, raw)
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new AppError("Choose an expiry in the future")
  return tx(async (db) => {
    if (input.groupId) await assertGroup(db, actor.tenantId, input.groupId)
    const token = `enr_${randomToken(24)}`
    const prefix = token.slice(0, 12)
    const row = await q1<{ id: string }>(
      `insert into enrollment_tokens (tenant_id, name, token_hash, prefix, group_id, expires_at, max_uses, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [actor.tenantId, input.name, sha256Hex(token), prefix, input.groupId ?? null, input.expiresAt ?? null, input.maxUses ?? null, actorId(actor)],
      db
    )
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "endpoint.token_created",
        entityType: "enrollment_token",
        entityId: row!.id,
        summary: `Created enrolment token "${input.name}" (${prefix}…)`,
        data: { group_id: input.groupId ?? null, expires_at: input.expiresAt ?? null, max_uses: input.maxUses ?? null },
      },
      db
    )
    return { id: row!.id, token, prefix }
  })
}

export async function revokeEnrollmentToken(actor: Actor, tokenId: string): Promise<void> {
  need(actor, "endpoint.manage")
  if (!isUuid(tokenId)) throw notFound("Token not found")
  await tx(async (db) => {
    const t = await q1<{ name: string; prefix: string }>(
      "update enrollment_tokens set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null returning name, prefix",
      [tokenId, actor.tenantId],
      db
    )
    if (!t) throw notFound("Token not found or already revoked")
    await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "endpoint.token_revoked", entityType: "enrollment_token", entityId: tokenId, summary: `Revoked enrolment token "${t.name}" (${t.prefix}…)` }, db)
  })
}

/* ── device groups (deployment rings) ──────────────────────────────────── */

export const groupSchema = z.object({
  name: z.string().trim().min(1, "Give the group a name").max(100, "Keep the name under 100 characters"),
  description: z.string().trim().max(1000).nullish(),
  ring: z.number().int().min(0, "Ring is 0 to 9").max(9, "Ring is 0 to 9"),
})

export async function createDeviceGroup(actor: Actor, raw: z.input<typeof groupSchema>): Promise<string> {
  need(actor, "endpoint.manage")
  const input = parse(groupSchema, raw)
  try {
    const row = await q1<{ id: string }>(
      "insert into device_groups (tenant_id, name, description, ring) values ($1, $2, $3, $4) returning id",
      [actor.tenantId, input.name, input.description || null, input.ring]
    )
    return row!.id
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("A device group with that name already exists")
    throw e
  }
}

export async function updateDeviceGroup(actor: Actor, groupId: string, raw: z.input<typeof groupSchema>): Promise<void> {
  need(actor, "endpoint.manage")
  if (!isUuid(groupId)) throw notFound("Group not found")
  const input = parse(groupSchema, raw)
  try {
    const n = await exec("update device_groups set name = $3, description = $4, ring = $5 where id = $1 and tenant_id = $2", [groupId, actor.tenantId, input.name, input.description || null, input.ring])
    if (!n) throw notFound("Group not found")
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("A device group with that name already exists")
    throw e
  }
}

export async function deleteDeviceGroup(actor: Actor, groupId: string): Promise<void> {
  need(actor, "endpoint.manage")
  if (!isUuid(groupId)) throw notFound("Group not found")
  await tx(async (db) => {
    const g = await q1<{ name: string; devices: number; policies: number }>(
      `select g.name,
              (select count(*) from devices d where d.group_id = g.id and d.tenant_id = g.tenant_id and d.status = 'active') as devices,
              (select count(*) from patch_policies p where p.device_group_id = g.id and p.tenant_id = g.tenant_id) as policies
         from device_groups g where g.id = $1 and g.tenant_id = $2 for update`,
      [groupId, actor.tenantId],
      db
    )
    if (!g) throw notFound("Group not found")
    if (g.devices > 0) throw new AppError(`Move the ${g.devices} device${g.devices === 1 ? "" : "s"} out of ${g.name} first`)
    await exec("delete from device_groups where id = $1 and tenant_id = $2", [groupId, actor.tenantId], db)
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "endpoint.group_deleted", entityType: "device_group", entityId: groupId, summary: `Deleted device group ${g.name}`, data: { policies_deleted: g.policies } },
      db
    )
  })
}

/* ── device actions ────────────────────────────────────────────────────── */

export async function requestDeviceJob(actor: Actor, deviceId: string, kind: "inventory" | "scan"): Promise<string> {
  need(actor, "endpoint.manage")
  const d = await loadDevice(pool(), actor, deviceId)
  if (d.status !== "active") throw new AppError("This device is retired")
  const open = await q1<{ id: string }>(
    "select id from agent_jobs where device_id = $1 and tenant_id = $2 and kind = $3 and status in ('queued', 'dispatched')",
    [d.id, actor.tenantId, kind]
  )
  if (open) throw new AppError(`A ${kind === "scan" ? "patch scan" : "inventory"} is already waiting for this device`)
  return queueAgentJob(pool(), { tenantId: actor.tenantId, deviceId: d.id, kind, payload: {}, createdBy: actorId(actor) })
}

export const rebootSchema = z.object({
  delaySeconds: z.number().int().min(0).max(86_400, "Delay at most 24 hours"),
  message: z.string().trim().max(500).nullish(),
})

export async function rebootDevice(actor: Actor, deviceId: string, raw: z.input<typeof rebootSchema>): Promise<string> {
  need(actor, "endpoint.manage")
  const input = parse(rebootSchema, raw)
  return tx(async (db) => {
    const d = await loadDevice(db, actor, deviceId)
    const id = await queueAgentJob(db, {
      tenantId: actor.tenantId,
      deviceId: d.id,
      kind: "reboot",
      payload: { delay_seconds: input.delaySeconds, message: input.message || "Your IT team is restarting this computer." },
      createdBy: actorId(actor),
    })
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "endpoint.reboot_requested", entityType: "device", entityId: d.id, summary: `Requested a reboot of ${d.hostname} in ${input.delaySeconds} s`, data: { job_id: id } },
      db
    )
    return id
  })
}

export const deviceSettingsSchema = z.object({
  groupId: ref().nullable(),
  tags: z.array(z.string().trim().min(1).max(50, "Keep each tag under 50 characters")).max(30, "At most 30 tags"),
})

export async function updateDeviceSettings(actor: Actor, deviceId: string, raw: z.input<typeof deviceSettingsSchema>): Promise<void> {
  need(actor, "endpoint.manage")
  const input = parse(deviceSettingsSchema, raw)
  const tags = [...new Set(input.tags)]
  await tx(async (db) => {
    const d = await loadDevice(db, actor, deviceId)
    if (input.groupId) await assertGroup(db, actor.tenantId, input.groupId)
    await exec("update devices set group_id = $3, tags = $4, updated_at = now() where id = $1 and tenant_id = $2", [d.id, actor.tenantId, input.groupId, tags], db)
    if (d.group_id !== input.groupId) {
      await audit(
        { tenantId: actor.tenantId, actor: auditActor(actor), action: "endpoint.device_moved", entityType: "device", entityId: d.id, summary: `Moved ${d.hostname} to another device group`, data: { from: d.group_id, to: input.groupId } },
        db
      )
    }
  })
}

/** Retires a device: it can no longer authenticate, and its open jobs are cancelled. */
export async function retireDevice(actor: Actor, deviceId: string): Promise<void> {
  need(actor, "endpoint.manage")
  await tx(async (db) => {
    const d = await loadDevice(db, actor, deviceId)
    if (d.status === "retired") throw new AppError("This device is already retired")
    // rotate the secret too, so the old credentials stay dead even if the device is reactivated
    await exec("update devices set status = 'retired', secret_hash = $3, updated_at = now() where id = $1 and tenant_id = $2", [d.id, actor.tenantId, sha256Hex(randomToken(32))], db)
    const deps = await q<{ deployment_id: string | null }>(
      "update agent_jobs set status = 'cancelled', finished_at = now() where device_id = $1 and tenant_id = $2 and status in ('queued', 'dispatched', 'running') returning deployment_id",
      [d.id, actor.tenantId],
      db
    )
    for (const dep of new Set(deps.map((r) => r.deployment_id).filter((x): x is string => !!x))) await maybeCompleteDeployment(db, actor.tenantId, dep)
    await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "endpoint.device_retired", entityType: "device", entityId: d.id, summary: `Retired device ${d.hostname}` }, db)
  })
}

export const scriptSchema = z.object({
  shell: z.enum(SHELLS),
  script: z.string().min(1, "Write the script to run").max(100_000, "Keep the script under 100,000 characters"),
  timeoutSeconds: z.number().int().min(10, "Timeout at least 10 seconds").max(3600, "Timeout at most 3600 seconds"),
})

/** Runs a script as SYSTEM/root on a device. Audit-logged with the script's hash and start. */
export async function runScript(actor: Actor, deviceId: string, raw: z.input<typeof scriptSchema>): Promise<string> {
  need(actor, "endpoint.run_script")
  const input = parse(scriptSchema, raw)
  // eslint-disable-next-line no-control-regex
  const script = input.script.replace(/\u0000/g, "")
  return tx(async (db) => {
    const d = await loadDevice(db, actor, deviceId)
    if (!shellsFor(d.os_family).includes(input.shell)) throw new AppError(`${input.shell} is not available on ${d.os_family} devices; use ${shellsFor(d.os_family).join(" or ")}`)
    const id = await queueAgentJob(db, {
      tenantId: actor.tenantId,
      deviceId: d.id,
      kind: "run_script",
      payload: { shell: input.shell, script, timeout_seconds: input.timeoutSeconds },
      createdBy: actorId(actor),
    })
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "endpoint.script_run",
        entityType: "device",
        entityId: d.id,
        summary: `Ran a ${input.shell} script on ${d.hostname}`,
        data: { job_id: id, shell: input.shell, timeout_seconds: input.timeoutSeconds, sha256: sha256Hex(script), length: script.length, preview: script.slice(0, 200) },
      },
      db
    )
    return id
  })
}

/** Cancels a job that has not started yet. */
export async function cancelAgentJob(actor: Actor, jobId: string): Promise<void> {
  need(actor, "endpoint.manage")
  if (!isUuid(jobId)) throw notFound("Job not found")
  await tx(async (db) => {
    const j = await q1<{ deployment_id: string | null }>(
      "update agent_jobs set status = 'cancelled', finished_at = now() where id = $1 and tenant_id = $2 and status in ('queued', 'dispatched') returning deployment_id",
      [jobId, actor.tenantId],
      db
    )
    if (!j) throw new AppError("Only a job that has not started can be cancelled")
    if (j.deployment_id) await maybeCompleteDeployment(db, actor.tenantId, j.deployment_id)
  })
}

/* ── patch approval and offline packages ───────────────────────────────── */

export async function setPatchApproval(actor: Actor, patchIds: string[], approval: Approval): Promise<number> {
  need(actor, "patch.approve")
  if (!(APPROVALS as readonly string[]).includes(approval)) throw new AppError("Unknown decision")
  const ids = [...new Set(patchIds.filter(isUuid))]
  if (!ids.length) throw new AppError("Select at least one patch")
  if (ids.length > 1000) throw new AppError("Select at most 1000 patches at a time")
  return tx(async (db) => {
    const rows = await q<{ id: string; title: string }>(
      `update patches set approval = $3, approved_by = case when $3 = 'pending' then null else $4::uuid end,
              approved_at = case when $3 = 'pending' then null else now() end, updated_at = now()
        where tenant_id = $1 and id = any($2::uuid[]) and approval <> $3
        returning id, title`,
      [actor.tenantId, ids, approval, actorId(actor)],
      db
    )
    if (rows.length) {
      await audit(
        {
          tenantId: actor.tenantId,
          actor: auditActor(actor),
          action: `patch.${approval === "approved" ? "approved" : approval === "declined" ? "declined" : "approval_reset"}`,
          entityType: "patch",
          entityId: rows.length === 1 ? rows[0].id : null,
          summary: rows.length === 1 ? `${approval === "pending" ? "Reset approval of" : approval === "approved" ? "Approved" : "Declined"} ${rows[0].title}` : `${approval === "pending" ? "Reset approval of" : approval === "approved" ? "Approved" : "Declined"} ${rows.length} patches`,
          data: { count: rows.length, patch_ids: rows.slice(0, 500).map((r) => r.id) },
        },
        db
      )
    }
    return rows.length
  })
}

/** Stores an offline package (air-gapped installs) for a patch. */
export async function attachPatchPackage(actor: Actor, patchId: string, buf: Buffer, fileName: string): Promise<{ fileId: string; sha256: string }> {
  need(actor, "patch.approve")
  if (!isUuid(patchId)) throw notFound("Patch not found")
  return tx(async (db) => {
    const p = await q1<{ id: string; title: string }>("select id, title from patches where id = $1 and tenant_id = $2 for update", [patchId, actor.tenantId], db)
    if (!p) throw notFound("Patch not found")
    const f = await saveBuffer(buf, fileName, { tenantId: actor.tenantId, entityType: "patch_package", entityId: p.id, uploadedBy: actorId(actor), kind: "package" }, db)
    await exec("update patches set package_file_id = $3, updated_at = now() where id = $1 and tenant_id = $2", [p.id, actor.tenantId, f.id], db)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "patch.package_uploaded",
        entityType: "patch",
        entityId: p.id,
        summary: `Uploaded offline package ${f.file_name} for ${p.title}`,
        data: { file_id: f.id, file_name: f.file_name, size_bytes: f.size_bytes, sha256: f.sha256 },
      },
      db
    )
    return { fileId: f.id, sha256: f.sha256 }
  })
}

export async function removePatchPackage(actor: Actor, patchId: string): Promise<void> {
  need(actor, "patch.approve")
  if (!isUuid(patchId)) throw notFound("Patch not found")
  await tx(async (db) => {
    const p = await q1<{ title: string; package_file_id: string | null }>("select title, package_file_id from patches where id = $1 and tenant_id = $2 for update", [patchId, actor.tenantId], db)
    if (!p) throw notFound("Patch not found")
    if (!p.package_file_id) throw new AppError("This patch has no offline package")
    await exec("update patches set package_file_id = null, updated_at = now() where id = $1 and tenant_id = $2", [patchId, actor.tenantId], db)
    await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "patch.package_removed", entityType: "patch", entityId: patchId, summary: `Removed the offline package of ${p.title}`, data: { file_id: p.package_file_id } }, db)
  })
}

/* ── patch policies ────────────────────────────────────────────────────── */

export const policySchema = z.object({
  name: z.string().trim().min(2, "Give the policy a name").max(200),
  description: z.string().trim().max(2000).nullish(),
  deviceGroupId: ref().nullable(),
  autoApproveClassifications: z.array(z.enum(CLASSIFICATIONS)).max(CLASSIFICATIONS.length),
  autoApproveDelayDays: z.number().int().min(0, "Delay is 0 to 365 days").max(365, "Delay is 0 to 365 days"),
  scheduleDays: z.array(z.number().int().min(0).max(6)).max(7),
  scheduleTime: z.string().refine((v) => !!parseTimeOfDay(v), "Time must look like 02:00"),
  maintenanceWindowId: ref().nullable(),
  rebootBehavior: z.enum(REBOOT_BEHAVIORS),
  isActive: z.boolean(),
})
export type PolicyInput = z.input<typeof policySchema>

type PolicyApprovalScope = { classes: string[]; delay: number; groupId: string | null; active: boolean }

async function checkPolicyRefs(db: Db, actor: Actor, input: z.output<typeof policySchema>, previous?: PolicyApprovalScope) {
  if (input.deviceGroupId) await assertGroup(db, actor.tenantId, input.deviceGroupId)
  if (input.maintenanceWindowId) {
    const w = await q1("select 1 from maintenance_windows where id = $1 and tenant_id = $2 and kind = 'maintenance'", [input.maintenanceWindowId, actor.tenantId], db)
    if (!w) throw new AppError("That maintenance window does not exist")
  }
  // auto-approval approves patches, so setting it up (or widening it) needs the approval permission
  if (input.autoApproveClassifications.length && !actor.permissions.has("patch.approve")) {
    const same =
      !!previous &&
      [...new Set(input.autoApproveClassifications)].sort().join(",") === [...previous.classes].sort().join(",") &&
      input.autoApproveDelayDays === previous.delay &&
      input.deviceGroupId === previous.groupId &&
      (input.isActive === previous.active || !input.isActive)
    if (!same) throw forbidden("Changing auto-approval needs the permission to approve patches")
  }
}

function policyValues(input: z.output<typeof policySchema>) {
  const t = parseTimeOfDay(input.scheduleTime)!
  return [
    input.name,
    input.description || null,
    input.deviceGroupId,
    [...new Set(input.autoApproveClassifications)],
    input.autoApproveDelayDays,
    [...new Set(input.scheduleDays)].sort((a, b) => a - b),
    `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`,
    input.maintenanceWindowId,
    input.rebootBehavior,
    input.isActive,
  ]
}

export async function createPolicy(actor: Actor, raw: PolicyInput): Promise<string> {
  need(actor, "patch.deploy")
  const input = parse(policySchema, raw)
  return tx(async (db) => {
    await checkPolicyRefs(db, actor, input)
    const row = await q1<{ id: string }>(
      `insert into patch_policies (tenant_id, name, description, device_group_id, auto_approve_classifications, auto_approve_delay_days,
                                   schedule_days, schedule_time, maintenance_window_id, reboot_behavior, is_active)
       values ($1, $2, $3, $4, $5, $6, $7::smallint[], $8::time, $9, $10, $11) returning id`,
      [actor.tenantId, ...policyValues(input)],
      db
    )
    await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "patch.policy_created", entityType: "patch_policy", entityId: row!.id, summary: `Created patch policy ${input.name}`, data: { ...input } }, db)
    return row!.id
  })
}

export async function updatePolicy(actor: Actor, policyId: string, raw: PolicyInput): Promise<void> {
  need(actor, "patch.deploy")
  if (!isUuid(policyId)) throw notFound("Policy not found")
  const input = parse(policySchema, raw)
  await tx(async (db) => {
    const prev = await q1<{ auto_approve_classifications: string[]; auto_approve_delay_days: number; device_group_id: string | null; is_active: boolean }>(
      "select auto_approve_classifications, auto_approve_delay_days, device_group_id, is_active from patch_policies where id = $1 and tenant_id = $2 for update",
      [policyId, actor.tenantId],
      db
    )
    if (!prev) throw notFound("Policy not found")
    await checkPolicyRefs(db, actor, input, { classes: prev.auto_approve_classifications, delay: prev.auto_approve_delay_days, groupId: prev.device_group_id, active: prev.is_active })
    const n = await exec(
      `update patch_policies set name = $3, description = $4, device_group_id = $5, auto_approve_classifications = $6, auto_approve_delay_days = $7,
              schedule_days = $8::smallint[], schedule_time = $9::time, maintenance_window_id = $10, reboot_behavior = $11, is_active = $12, updated_at = now()
        where id = $1 and tenant_id = $2`,
      [policyId, actor.tenantId, ...policyValues(input)],
      db
    )
    if (!n) throw notFound("Policy not found")
    await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "patch.policy_updated", entityType: "patch_policy", entityId: policyId, summary: `Updated patch policy ${input.name}`, data: { ...input } }, db)
  })
}

export async function deletePolicy(actor: Actor, policyId: string): Promise<void> {
  need(actor, "patch.deploy")
  if (!isUuid(policyId)) throw notFound("Policy not found")
  await tx(async (db) => {
    const p = await q1<{ name: string }>("delete from patch_policies where id = $1 and tenant_id = $2 returning name", [policyId, actor.tenantId], db)
    if (!p) throw notFound("Policy not found")
    await audit({ tenantId: actor.tenantId, actor: auditActor(actor), action: "patch.policy_deleted", entityType: "patch_policy", entityId: policyId, summary: `Deleted patch policy ${p.name}` }, db)
  })
}
