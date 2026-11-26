/** Read side of endpoints and patches: lists with filters, details, compliance. All queries filter on the tenant. */
import { q, q1, Params, isUuid, pool, type Db } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { notFound } from "@/lib/errors"
import {
  APPROVALS,
  CLASSIFICATIONS,
  COMPLIANCE_CLASSIFICATIONS,
  OS_FAMILIES,
  ONLINE_MINUTES,
  SEVERITIES,
  STALE_DAYS,
  isOneOf,
} from "@/lib/endpoints/vocab"

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => "\\" + c)}%`

/* ── devices ───────────────────────────────────────────────────────────── */

export type DeviceFilters = {
  q?: string
  os?: string
  group?: string // uuid | none
  seen?: string // online | offline | stale
  missing?: string // critical
  reboot?: string // 1
  status?: string // active (default) | retired | all
  page?: number
  pageSize?: number
}

export type DeviceListRow = {
  id: string
  hostname: string
  os_family: string
  os_name: string | null
  os_version: string | null
  serial_no: string | null
  status: string
  group_id: string | null
  group_name: string | null
  last_seen_at: Date | null
  last_ip: string | null
  agent_version: string | null
  reboot_pending: boolean
  missing: number
  missing_critical: number
  tags: string[]
  total: number
}

export async function listDevices(actor: Actor, f: DeviceFilters) {
  const p = new Params()
  const where = [`d.tenant_id = ${p.add(actor.tenantId)}`]
  const status = f.status ?? "active"
  if (status === "active" || status === "retired") where.push(`d.status = ${p.add(status)}`)
  const text = f.q?.trim()
  if (text) {
    const l = p.add(like(text))
    where.push(`(d.hostname ilike ${l} or d.serial_no ilike ${l} or d.last_ip ilike ${l} or array_to_string(d.ip_addresses, ' ') ilike ${l} or d.logged_on_user ilike ${l})`)
  }
  if (f.os && isOneOf(OS_FAMILIES, f.os)) where.push(`d.os_family = ${p.add(f.os)}`)
  if (f.group === "none") where.push("d.group_id is null")
  else if (f.group && isUuid(f.group)) where.push(`d.group_id = ${p.add(f.group)}`)
  if (f.seen === "online") where.push(`d.last_seen_at > now() - interval '${ONLINE_MINUTES} minutes'`)
  else if (f.seen === "offline") where.push(`(d.last_seen_at is null or d.last_seen_at <= now() - interval '${ONLINE_MINUTES} minutes')`)
  else if (f.seen === "stale") where.push(`(d.last_seen_at is null or d.last_seen_at < now() - interval '${STALE_DAYS} days')`)
  if (f.missing === "critical") where.push("coalesce(m.missing_critical, 0) > 0")
  if (f.reboot === "1") where.push("d.reboot_pending")
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 10), 200)
  const page = Math.max(f.page ?? 1, 1)
  const rows = await q<DeviceListRow>(
    `select d.id, d.hostname, d.os_family, d.os_name, d.os_version, d.serial_no, d.status, d.group_id, g.name as group_name, d.last_seen_at, d.last_ip,
            d.agent_version, d.reboot_pending, d.tags, coalesce(m.missing, 0) as missing, coalesce(m.missing_critical, 0) as missing_critical,
            count(*) over () as total
       from devices d
       left join device_groups g on g.id = d.group_id and g.tenant_id = d.tenant_id
       left join lateral (
         select count(*) as missing, count(*) filter (where p.severity = 'critical') as missing_critical
           from device_patches dp join patches p on p.id = dp.patch_id and p.tenant_id = d.tenant_id
          where dp.device_id = d.id and dp.state in ('missing', 'failed') and p.approval <> 'declined'
       ) m on true
      where ${where.join(" and ")}
      order by lower(d.hostname), d.id
      limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export type DeviceGroupRow = { id: string; name: string; description: string | null; ring: number; devices: number; policies: number; created_at: Date }

export async function listDeviceGroups(tenantId: string, db: Db = pool()): Promise<DeviceGroupRow[]> {
  return q<DeviceGroupRow>(
    `select g.id, g.name, g.description, g.ring, g.created_at,
            (select count(*) from devices d where d.group_id = g.id and d.tenant_id = g.tenant_id and d.status = 'active') as devices,
            (select count(*) from patch_policies p where p.device_group_id = g.id and p.tenant_id = g.tenant_id) as policies
       from device_groups g where g.tenant_id = $1 order by g.ring, lower(g.name)`,
    [tenantId],
    db
  )
}

export type DeviceRow = {
  id: string
  tenant_id: string
  hostname: string
  os_family: string
  os_name: string | null
  os_version: string | null
  os_build: string | null
  arch: string | null
  domain: string | null
  agent_version: string | null
  status: string
  group_id: string | null
  group_name: string | null
  tags: string[]
  ci_id: string | null
  ci_code: string | null
  ci_name: string | null
  manufacturer: string | null
  model: string | null
  serial_no: string | null
  cpu: string | null
  cpu_cores: number | null
  ram_mb: number | null
  disk_total_gb: number | null
  disk_free_gb: number | null
  mac_addresses: string[]
  ip_addresses: string[]
  logged_on_user: string | null
  uptime_seconds: number | null
  reboot_pending: boolean
  inventory: Record<string, unknown>
  last_seen_at: Date | null
  last_ip: string | null
  last_inventory_at: Date | null
  last_scan_at: Date | null
  enrolled_at: Date
  updated_at: Date
}

export async function getDevice(actor: Actor, id: string): Promise<DeviceRow> {
  if (!isUuid(id)) throw notFound("Device not found")
  const d = await q1<DeviceRow>(
    `select d.id, d.tenant_id, d.hostname, d.os_family, d.os_name, d.os_version, d.os_build, d.arch, d.domain, d.agent_version, d.status,
            d.group_id, g.name as group_name, d.tags, d.ci_id, c.ci_code, c.name as ci_name, d.manufacturer, d.model, d.serial_no, d.cpu,
            d.cpu_cores, d.ram_mb, d.disk_total_gb, d.disk_free_gb, d.mac_addresses, d.ip_addresses, d.logged_on_user, d.uptime_seconds,
            d.reboot_pending, d.inventory, d.last_seen_at, d.last_ip, d.last_inventory_at, d.last_scan_at, d.enrolled_at, d.updated_at
       from devices d
       left join device_groups g on g.id = d.group_id and g.tenant_id = d.tenant_id
       left join configuration_items c on c.id = d.ci_id and c.tenant_id = d.tenant_id
      where d.id = $1 and d.tenant_id = $2`,
    [id, actor.tenantId]
  )
  if (!d) throw notFound("Device not found")
  return d
}

export async function deviceSoftware(actor: Actor, deviceId: string, text?: string, limit = 1000) {
  const p = new Params()
  const where = [`s.device_id = ${p.add(deviceId)}`, `d.tenant_id = ${p.add(actor.tenantId)}`]
  if (text?.trim()) {
    const l = p.add(like(text.trim()))
    where.push(`(s.name ilike ${l} or s.publisher ilike ${l} or s.version ilike ${l})`)
  }
  const rows = await q<{ name: string; version: string; publisher: string | null; installed_on: string | null; total: number }>(
    `select s.name, s.version, s.publisher, s.installed_on, count(*) over () as total
       from device_software s join devices d on d.id = s.device_id
      where ${where.join(" and ")}
      order by lower(s.name), s.version limit ${limit}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0 }
}

export type DevicePatchRow = {
  patch_id: string
  state: string
  detected_at: Date
  installed_at: Date | null
  last_error: string | null
  title: string
  kb: string | null
  severity: string
  classification: string
  approval: string
  release_date: string | null
}

export async function devicePatches(actor: Actor, deviceId: string): Promise<DevicePatchRow[]> {
  return q<DevicePatchRow>(
    `select dp.patch_id, dp.state, dp.detected_at, dp.installed_at, dp.last_error, p.title, p.kb, p.severity, p.classification, p.approval, p.release_date
       from device_patches dp
       join patches p on p.id = dp.patch_id and p.tenant_id = $2
       join devices d on d.id = dp.device_id and d.tenant_id = $2
      where dp.device_id = $1
      order by case dp.state when 'failed' then 0 when 'missing' then 1 when 'pending_reboot' then 2 else 3 end,
               case p.severity when 'critical' then 0 when 'important' then 1 when 'moderate' then 2 when 'low' then 3 else 4 end,
               dp.installed_at desc nulls last, p.title
      limit 3000`,
    [deviceId, actor.tenantId]
  )
}

export type AgentJobRow = {
  id: string
  kind: string
  status: string
  payload: Record<string, unknown>
  deployment_id: string | null
  deployment_name: string | null
  created_by_name: string | null
  not_before: Date
  expires_at: Date | null
  dispatched_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  exit_code: number | null
  output: string | null
  result: Record<string, unknown> | null
  created_at: Date
}

export async function deviceJobs(actor: Actor, deviceId: string, limit = 100): Promise<AgentJobRow[]> {
  return q<AgentJobRow>(
    `select j.id, j.kind, j.status, j.payload, j.deployment_id, pd.name as deployment_name, u.full_name as created_by_name, j.not_before, j.expires_at,
            j.dispatched_at, j.started_at, j.finished_at, j.exit_code, j.output, j.result, j.created_at
       from agent_jobs j
       left join patch_deployments pd on pd.id = j.deployment_id and pd.tenant_id = j.tenant_id
       left join users u on u.id = j.created_by
      where j.device_id = $1 and j.tenant_id = $2
      order by j.created_at desc limit ${Math.min(500, Math.max(1, limit))}`,
    [deviceId, actor.tenantId]
  )
}

/* ── enrolment tokens ──────────────────────────────────────────────────── */

export type TokenRow = {
  id: string
  name: string
  prefix: string
  group_name: string | null
  expires_at: Date | null
  max_uses: number | null
  uses: number
  revoked_at: Date | null
  created_by_name: string | null
  created_at: Date
  state: "active" | "revoked" | "expired" | "used_up"
}

export async function listEnrollmentTokens(tenantId: string): Promise<TokenRow[]> {
  return q<TokenRow>(
    `select t.id, t.name, t.prefix, g.name as group_name, t.expires_at, t.max_uses, t.uses, t.revoked_at, u.full_name as created_by_name, t.created_at,
            case when t.revoked_at is not null then 'revoked'
                 when t.expires_at is not null and t.expires_at <= now() then 'expired'
                 when t.max_uses is not null and t.uses >= t.max_uses then 'used_up'
                 else 'active' end as state
       from enrollment_tokens t
       left join device_groups g on g.id = t.group_id and g.tenant_id = t.tenant_id
       left join users u on u.id = t.created_by
      where t.tenant_id = $1
      order by (t.revoked_at is null) desc, t.created_at desc limit 200`,
    [tenantId]
  )
}

/* ── patches ───────────────────────────────────────────────────────────── */

export type PatchFilters = {
  q?: string
  os?: string
  severity?: string
  classification?: string
  approval?: string
  missing?: string // 1 = only missing somewhere
  page?: number
  pageSize?: number
}

export type PatchListRow = {
  id: string
  title: string
  kb: string | null
  external_id: string
  os_family: string
  source: string
  severity: string
  classification: string
  approval: string
  release_date: string | null
  package_file_id: string | null
  missing: number
  installed: number
  failed: number
  first_seen_at: Date
  total: number
}

const PATCH_COUNTS = `left join lateral (
         select count(*) filter (where dp.state in ('missing', 'failed')) as missing,
                count(*) filter (where dp.state in ('installed', 'pending_reboot')) as installed,
                count(*) filter (where dp.state = 'failed') as failed
           from device_patches dp join devices d on d.id = dp.device_id and d.tenant_id = p.tenant_id and d.status = 'active'
          where dp.patch_id = p.id
       ) c on true`

export async function listPatches(actor: Actor, f: PatchFilters) {
  const p = new Params()
  const where = [`p.tenant_id = ${p.add(actor.tenantId)}`]
  const text = f.q?.trim()
  if (text) {
    const l = p.add(like(text))
    where.push(`(p.title ilike ${l} or p.kb ilike ${l} or p.external_id ilike ${l})`)
  }
  if (f.os && isOneOf(OS_FAMILIES, f.os)) where.push(`p.os_family = ${p.add(f.os)}`)
  if (f.severity && isOneOf(SEVERITIES, f.severity)) where.push(`p.severity = ${p.add(f.severity)}`)
  if (f.classification && isOneOf(CLASSIFICATIONS, f.classification)) where.push(`p.classification = ${p.add(f.classification)}`)
  if (f.approval && isOneOf(APPROVALS, f.approval)) where.push(`p.approval = ${p.add(f.approval)}`)
  if (f.missing === "1") where.push("coalesce(c.missing, 0) > 0")
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 10), 200)
  const page = Math.max(f.page ?? 1, 1)
  const rows = await q<PatchListRow>(
    `select p.id, p.title, p.kb, p.external_id, p.os_family, p.source, p.severity, p.classification, p.approval, p.release_date, p.package_file_id,
            p.first_seen_at, coalesce(c.missing, 0) as missing, coalesce(c.installed, 0) as installed, coalesce(c.failed, 0) as failed,
            count(*) over () as total
       from patches p
       ${PATCH_COUNTS}
      where ${where.join(" and ")}
      order by coalesce(c.missing, 0) > 0 desc,
               case p.severity when 'critical' then 0 when 'important' then 1 when 'moderate' then 2 when 'low' then 3 else 4 end,
               p.release_date desc nulls last, p.title
      limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export type PatchDetail = {
  id: string
  os_family: string
  source: string
  external_id: string
  kb: string | null
  title: string
  description: string | null
  classification: string
  severity: string
  version: string | null
  release_date: string | null
  size_bytes: number | null
  reboot_required: boolean
  support_url: string | null
  approval: string
  approved_by_name: string | null
  approved_at: Date | null
  package_file_id: string | null
  package_name: string | null
  package_size: number | null
  package_sha256: string | null
  package_uploaded_at: Date | null
  first_seen_at: Date
  updated_at: Date
}

export async function getPatch(actor: Actor, id: string): Promise<PatchDetail> {
  if (!isUuid(id)) throw notFound("Patch not found")
  const p = await q1<PatchDetail>(
    `select p.id, p.os_family, p.source, p.external_id, p.kb, p.title, p.description, p.classification, p.severity, p.version, p.release_date,
            p.size_bytes, p.reboot_required, p.support_url, p.approval, u.full_name as approved_by_name, p.approved_at, p.package_file_id,
            f.file_name as package_name, f.size_bytes as package_size, f.sha256 as package_sha256, f.created_at as package_uploaded_at,
            p.first_seen_at, p.updated_at
       from patches p
       left join users u on u.id = p.approved_by
       left join files f on f.id = p.package_file_id and f.tenant_id = p.tenant_id
      where p.id = $1 and p.tenant_id = $2`,
    [id, actor.tenantId]
  )
  if (!p) throw notFound("Patch not found")
  return p
}

export async function patchDevices(actor: Actor, patchId: string) {
  return q<{ device_id: string; hostname: string; group_name: string | null; state: string; detected_at: Date; installed_at: Date | null; last_error: string | null; last_seen_at: Date | null }>(
    `select d.id as device_id, d.hostname, g.name as group_name, dp.state, dp.detected_at, dp.installed_at, dp.last_error, d.last_seen_at
       from device_patches dp
       join devices d on d.id = dp.device_id and d.tenant_id = $2 and d.status = 'active'
       left join device_groups g on g.id = d.group_id and g.tenant_id = d.tenant_id
      where dp.patch_id = $1
      order by case dp.state when 'failed' then 0 when 'missing' then 1 when 'pending_reboot' then 2 else 3 end, lower(d.hostname)
      limit 5000`,
    [patchId, actor.tenantId]
  )
}

/** Approved patches with how many active devices miss them (deployment picker). */
export async function approvedPatchOptions(actor: Actor, f: { q?: string; os?: string; all?: boolean }) {
  const p = new Params()
  const where = [`p.tenant_id = ${p.add(actor.tenantId)}`, "p.approval = 'approved'"]
  if (f.q?.trim()) {
    const l = p.add(like(f.q.trim()))
    where.push(`(p.title ilike ${l} or p.kb ilike ${l} or p.external_id ilike ${l})`)
  }
  if (f.os && isOneOf(OS_FAMILIES, f.os)) where.push(`p.os_family = ${p.add(f.os)}`)
  if (!f.all) where.push("coalesce(c.missing, 0) > 0")
  return q<{ id: string; title: string; kb: string | null; os_family: string; severity: string; classification: string; missing: number; package_file_id: string | null }>(
    `select p.id, p.title, p.kb, p.os_family, p.severity, p.classification, coalesce(c.missing, 0) as missing, p.package_file_id
       from patches p ${PATCH_COUNTS}
      where ${where.join(" and ")}
      order by case p.severity when 'critical' then 0 when 'important' then 1 when 'moderate' then 2 when 'low' then 3 else 4 end, c.missing desc nulls last, p.title
      limit 1000`,
    p.values
  )
}

export async function deviceOptions(tenantId: string) {
  return q<{ id: string; hostname: string; os_family: string; group_name: string | null }>(
    `select d.id, d.hostname, d.os_family, g.name as group_name from devices d left join device_groups g on g.id = d.group_id and g.tenant_id = d.tenant_id
      where d.tenant_id = $1 and d.status = 'active' order by lower(d.hostname) limit 5000`,
    [tenantId]
  )
}

export async function patchMaintenanceWindows(tenantId: string) {
  return q<{ id: string; name: string; starts_at: Date; ends_at: Date; recurrence: string }>(
    `select id, name, starts_at, ends_at, recurrence from maintenance_windows
      where tenant_id = $1 and is_active and kind = 'maintenance' and applies_to in ('all', 'patches') order by name`,
    [tenantId]
  )
}

/* ── deployments ───────────────────────────────────────────────────────── */

export type DeploymentListRow = {
  id: string
  name: string
  status: string
  patch_count: number
  group_names: string[]
  device_count: number
  scheduled_at: Date | null
  maintenance_window_name: string | null
  started_at: Date | null
  completed_at: Date | null
  created_at: Date
  created_by_name: string | null
  policy_name: string | null
  change_number: string | null
  jobs_total: number
  jobs_done: number
  jobs_failed: number
  total: number
}

export async function listDeployments(actor: Actor, f: { status?: string; page?: number; pageSize?: number }) {
  const p = new Params()
  const where = [`pd.tenant_id = ${p.add(actor.tenantId)}`]
  if (f.status && ["draft", "scheduled", "running", "completed", "cancelled"].includes(f.status)) where.push(`pd.status = ${p.add(f.status)}`)
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 10), 100)
  const page = Math.max(f.page ?? 1, 1)
  const rows = await q<DeploymentListRow>(
    `select pd.id, pd.name, pd.status, cardinality(pd.patch_ids) as patch_count, cardinality(pd.target_device_ids) as device_count,
            array(select g.name from device_groups g where g.id = any(pd.target_group_ids) and g.tenant_id = pd.tenant_id order by g.ring, g.name) as group_names,
            pd.scheduled_at, mw.name as maintenance_window_name, pd.started_at, pd.completed_at, pd.created_at, u.full_name as created_by_name,
            pol.name as policy_name, t.number as change_number,
            coalesce(j.total, 0) as jobs_total, coalesce(j.done, 0) as jobs_done, coalesce(j.failed, 0) as jobs_failed,
            count(*) over () as total
       from patch_deployments pd
       left join users u on u.id = pd.created_by
       left join maintenance_windows mw on mw.id = pd.maintenance_window_id and mw.tenant_id = pd.tenant_id
       left join patch_policies pol on pol.id = pd.policy_id and pol.tenant_id = pd.tenant_id
       left join tickets t on t.id = pd.change_id and t.tenant_id = pd.tenant_id
       left join lateral (
         select count(*) as total,
                count(*) filter (where aj.status in ('succeeded', 'failed', 'cancelled', 'expired')) as done,
                count(*) filter (where aj.status in ('failed', 'expired')) as failed
           from agent_jobs aj where aj.deployment_id = pd.id and aj.tenant_id = pd.tenant_id
       ) j on true
      where ${where.join(" and ")}
      order by pd.created_at desc
      limit ${pageSize} offset ${(page - 1) * pageSize}`,
    p.values
  )
  return { rows, total: rows[0]?.total ?? 0, page, pageSize }
}

export async function getDeployment(actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound("Deployment not found")
  const d = await q1<{
    id: string
    name: string
    description: string | null
    status: string
    patch_ids: string[]
    target_device_ids: string[]
    target_group_ids: string[]
    scheduled_at: Date | null
    maintenance_window_id: string | null
    maintenance_window_name: string | null
    reboot_behavior: string
    change_number: string | null
    change_subject: string | null
    policy_id: string | null
    policy_name: string | null
    created_by_name: string | null
    created_at: Date
    started_at: Date | null
    completed_at: Date | null
  }>(
    `select pd.id, pd.name, pd.description, pd.status, pd.patch_ids, pd.target_device_ids, pd.target_group_ids, pd.scheduled_at,
            pd.maintenance_window_id, mw.name as maintenance_window_name, pd.reboot_behavior, t.number as change_number, t.subject as change_subject,
            pd.policy_id, pol.name as policy_name, u.full_name as created_by_name, pd.created_at, pd.started_at, pd.completed_at
       from patch_deployments pd
       left join maintenance_windows mw on mw.id = pd.maintenance_window_id and mw.tenant_id = pd.tenant_id
       left join tickets t on t.id = pd.change_id and t.tenant_id = pd.tenant_id
       left join patch_policies pol on pol.id = pd.policy_id and pol.tenant_id = pd.tenant_id
       left join users u on u.id = pd.created_by
      where pd.id = $1 and pd.tenant_id = $2`,
    [id, actor.tenantId]
  )
  if (!d) throw notFound("Deployment not found")
  const [patches, groups, devices, jobs] = await Promise.all([
    q<{ id: string; title: string; kb: string | null; severity: string; approval: string }>(
      "select id, title, kb, severity, approval from patches where tenant_id = $1 and id = any($2::uuid[]) order by title",
      [actor.tenantId, d.patch_ids]
    ),
    q<{ id: string; name: string; ring: number }>("select id, name, ring from device_groups where tenant_id = $1 and id = any($2::uuid[]) order by ring, name", [actor.tenantId, d.target_group_ids]),
    q<{ id: string; hostname: string }>("select id, hostname from devices where tenant_id = $1 and id = any($2::uuid[]) order by lower(hostname) limit 500", [actor.tenantId, d.target_device_ids]),
    q<AgentJobRow & { device_id: string; hostname: string }>(
      `select j.id, j.kind, j.status, j.payload, j.deployment_id, null as deployment_name, null as created_by_name, j.not_before, j.expires_at,
              j.dispatched_at, j.started_at, j.finished_at, j.exit_code, j.output, j.result, j.created_at, j.device_id, dv.hostname
         from agent_jobs j join devices dv on dv.id = j.device_id and dv.tenant_id = j.tenant_id
        where j.deployment_id = $1 and j.tenant_id = $2
        order by case j.status when 'failed' then 0 when 'running' then 1 when 'dispatched' then 2 when 'queued' then 3 else 4 end, lower(dv.hostname)
        limit 5000`,
      [d.id, actor.tenantId]
    ),
  ])
  return { deployment: d, patches, groups, devices, jobs }
}

/* ── policies ──────────────────────────────────────────────────────────── */

export type PolicyRow = {
  id: string
  name: string
  description: string | null
  device_group_id: string | null
  group_name: string | null
  auto_approve_classifications: string[]
  auto_approve_delay_days: number
  schedule_days: number[]
  schedule_time: string
  maintenance_window_id: string | null
  maintenance_window_name: string | null
  reboot_behavior: string
  is_active: boolean
  last_run_at: Date | null
  created_at: Date
}

const POLICY_SELECT = `select p.id, p.name, p.description, p.device_group_id, g.name as group_name, p.auto_approve_classifications, p.auto_approve_delay_days,
            p.schedule_days, to_char(p.schedule_time, 'HH24:MI') as schedule_time, p.maintenance_window_id, mw.name as maintenance_window_name,
            p.reboot_behavior, p.is_active, p.last_run_at, p.created_at
       from patch_policies p
       left join device_groups g on g.id = p.device_group_id and g.tenant_id = p.tenant_id
       left join maintenance_windows mw on mw.id = p.maintenance_window_id and mw.tenant_id = p.tenant_id`

export async function listPolicies(tenantId: string): Promise<PolicyRow[]> {
  return q<PolicyRow>(`${POLICY_SELECT} where p.tenant_id = $1 order by p.is_active desc, lower(p.name)`, [tenantId])
}

export async function getPolicy(actor: Actor, id: string): Promise<PolicyRow> {
  if (!isUuid(id)) throw notFound("Policy not found")
  const p = await q1<PolicyRow>(`${POLICY_SELECT} where p.id = $1 and p.tenant_id = $2`, [id, actor.tenantId])
  if (!p) throw notFound("Policy not found")
  return p
}

/* ── compliance ────────────────────────────────────────────────────────── */

/** Missing approved security/critical patches per active device. */
const DEVICE_COMPLIANCE = `
  select d.id, d.hostname, d.os_family, d.os_name, d.group_id, g.name as group_name, d.last_seen_at, d.last_scan_at, d.reboot_pending,
         coalesce(m.missing_required, 0) as missing_required, coalesce(m.missing_any, 0) as missing_any
    from devices d
    left join device_groups g on g.id = d.group_id and g.tenant_id = d.tenant_id
    left join lateral (
      select count(*) filter (where p.approval = 'approved' and p.classification = any($2::text[])) as missing_required,
             count(*) filter (where p.approval <> 'declined') as missing_any
        from device_patches dp join patches p on p.id = dp.patch_id and p.tenant_id = d.tenant_id
       where dp.device_id = d.id and dp.state in ('missing', 'failed')
    ) m on true
   where d.tenant_id = $1 and d.status = 'active'`

export type ComplianceDeviceRow = {
  id: string
  hostname: string
  os_family: string
  os_name: string | null
  group_id: string | null
  group_name: string | null
  last_seen_at: Date | null
  last_scan_at: Date | null
  reboot_pending: boolean
  missing_required: number
  missing_any: number
}

export async function complianceDevices(tenantId: string): Promise<ComplianceDeviceRow[]> {
  return q<ComplianceDeviceRow>(`${DEVICE_COMPLIANCE} order by coalesce(m.missing_required, 0) desc, lower(d.hostname)`, [tenantId, COMPLIANCE_CLASSIFICATIONS])
}

export async function complianceSummary(tenantId: string) {
  const devices = await complianceDevices(tenantId)
  const compliant = devices.filter((d) => d.missing_required === 0).length
  const groups = new Map<string, { group_id: string | null; name: string; devices: number; compliant: number }>()
  for (const d of devices) {
    const key = d.group_id ?? "none"
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { group_id: d.group_id, name: d.group_name ?? "No group", devices: 0, compliant: 0 }))
    g.devices++
    if (d.missing_required === 0) g.compliant++
  }
  const staleCutoff = Date.now() - 7 * 86_400_000
  const stale = devices.filter((d) => !d.last_seen_at || new Date(d.last_seen_at).getTime() < staleCutoff)
  const neverScanned = devices.filter((d) => !d.last_scan_at).length
  const topMissing = await q<{ id: string; title: string; kb: string | null; severity: string; classification: string; approval: string; missing: number }>(
    `select p.id, p.title, p.kb, p.severity, p.classification, p.approval, count(*) as missing
       from device_patches dp
       join patches p on p.id = dp.patch_id and p.tenant_id = $1
       join devices d on d.id = dp.device_id and d.tenant_id = $1 and d.status = 'active'
      where dp.state in ('missing', 'failed') and p.approval <> 'declined'
      group by p.id
      order by count(*) desc, case p.severity when 'critical' then 0 when 'important' then 1 when 'moderate' then 2 when 'low' then 3 else 4 end, p.title
      limit 10`,
    [tenantId]
  )
  return {
    total: devices.length,
    compliant,
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    stale: stale.sort((a, b) => (a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0) - (b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0)),
    neverScanned,
    rebootPending: devices.filter((d) => d.reboot_pending).length,
    topMissing,
  }
}
