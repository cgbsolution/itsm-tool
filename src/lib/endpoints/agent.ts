/**
 * Agent side of the endpoint module: what the /api/agent/v1 route handlers
 * call. A device authenticates with its own id and secret and only ever acts
 * inside its own tenant (taken from the device row, never from the request).
 * Secrets and enrolment tokens are never logged.
 */
import { q, q1, exec, tx, isUuid, type Db } from "@/lib/db"
import { randomToken, safeEqual, sha256Hex } from "@/lib/crypto"
import { AppError, notFound } from "@/lib/errors"
import { enforce } from "@/lib/rate-limit"
import { licenseStatus } from "@/lib/license"
import { audit } from "@/lib/audit"
import { log } from "@/lib/log"
import { parse } from "@/lib/validate"
import {
  enrollSchema,
  heartbeatSchema,
  inventorySchema,
  jobUpdateSchema,
  parseDeviceAuth,
  parseInstallResult,
  patchScanSchema,
  truncateUtf8,
  cleanJson,
  POLL_INTERVAL_SECONDS,
  MAX_WAIT_SECONDS,
  type AvailablePatch,
} from "@/lib/endpoints/protocol"
import { applyAutoApproval, maybeCompleteDeployment, withRetry } from "@/lib/endpoints/core"
import { linkDeviceToCi } from "@/lib/endpoints/cmdb-link"
import { osFamilyForSource, type OsFamily } from "@/lib/endpoints/vocab"
import type { JobPatch } from "@/lib/endpoints/planning"

export type AgentDevice = {
  id: string
  tenantId: string
  hostname: string
  osFamily: OsFamily
  groupId: string | null
  rebootPending: boolean
}

const unauthorized = () => new AppError("Device not recognised: it was retired or its secret was rotated. Re-enrol the device.", 401, "unauthorized")
const DUMMY_HASH = sha256Hex("no-such-device")

/* ── enrolment ─────────────────────────────────────────────────────────── */

export async function enrollDevice(raw: unknown, ip: string | null): Promise<{ device_id: string; device_secret: string; poll_interval_seconds: number; server_time: string }> {
  await enforce(`agent.enroll:${ip ?? "unknown"}`, 120, 600, "Too many enrolment attempts from this address. Wait a few minutes and try again.")
  const input = parse(enrollSchema, raw)
  const secret = randomToken(32)
  const result = await tx(async (db) => {
    const tok = await q1<{ id: string; tenant_id: string; name: string; prefix: string; group_id: string | null; usable: boolean }>(
      `select id, tenant_id, name, prefix, group_id,
              (revoked_at is null and (expires_at is null or expires_at > now()) and (max_uses is null or uses < max_uses)) as usable
         from enrollment_tokens where token_hash = $1 for update`,
      [sha256Hex(input.token)],
      db
    )
    if (!tok || !tok.usable) throw new AppError("The enrolment token is invalid, expired, revoked or used up", 403, "token_invalid")
    const tenantId = tok.tenant_id
    // one enrolment at a time per tenant, so the licence count cannot be raced
    await q("select pg_advisory_xact_lock(hashtext($1))", [`endpoints.enroll:${tenantId}`], db)

    const existing = input.serial_no
      ? await q1<{ id: string }>(
          `select id from devices
            where tenant_id = $1 and status = 'active' and lower(hostname) = lower($2) and serial_no = $3
            order by enrolled_at desc limit 1 for update`,
          [tenantId, input.hostname, input.serial_no],
          db
        )
      : null

    let deviceId: string
    if (existing) {
      deviceId = existing.id
      await exec(
        `update devices set secret_hash = $3, hostname = $4, os_family = $5, os_name = coalesce($6, os_name), os_version = coalesce($7, os_version),
                arch = coalesce($8, arch), agent_version = coalesce($9, agent_version), mac_addresses = coalesce($10::text[], mac_addresses),
                last_seen_at = now(), last_ip = coalesce($11, last_ip), updated_at = now()
          where id = $1 and tenant_id = $2`,
        [deviceId, tenantId, sha256Hex(secret), input.hostname, input.os_family, input.os_name, input.os_version, input.arch, input.agent_version, input.mac_addresses ?? null, ip],
        db
      )
    } else {
      const lic = await licenseStatus()
      const count = await q1<{ n: number }>("select count(*) as n from devices where tenant_id = $1 and status = 'active'", [tenantId], db)
      if ((count?.n ?? 0) >= lic.maxDevices) {
        throw new AppError(
          lic.maxDevices === 0 ? "The licence does not allow new devices (it may have expired)" : `The licence device limit (${lic.maxDevices}) is reached`,
          402,
          "license_limit"
        )
      }
      const row = await q1<{ id: string }>(
        `insert into devices (tenant_id, hostname, os_family, os_name, os_version, arch, agent_version, serial_no, mac_addresses, secret_hash, group_id, last_seen_at, last_ip)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::text[], array[]::text[]), $10,
                 (select id from device_groups where id = $11 and tenant_id = $1), now(), $12)
         returning id`,
        [tenantId, input.hostname, input.os_family, input.os_name, input.os_version, input.arch, input.agent_version, input.serial_no, input.mac_addresses ?? null, sha256Hex(secret), tok.group_id, ip],
        db
      )
      deviceId = row!.id
    }
    await exec("update enrollment_tokens set uses = uses + 1 where id = $1", [tok.id], db)
    await audit(
      {
        tenantId,
        actor: null,
        action: existing ? "endpoint.reenrolled" : "endpoint.enrolled",
        entityType: "device",
        entityId: deviceId,
        summary: `${input.hostname} ${existing ? "re-enrolled (secret rotated)" : "enrolled"} with token "${tok.name}" (${tok.prefix}…)`,
        data: { token_id: tok.id, hostname: input.hostname, os_family: input.os_family, serial_no: input.serial_no, agent_version: input.agent_version, reinstall: !!existing },
        ip,
      },
      db
    )
    return { deviceId, tenantId, reinstall: !!existing }
  })
  log.info("agent.enrolled", { device_id: result.deviceId, tenant_id: result.tenantId, reinstall: result.reinstall })
  return { device_id: result.deviceId, device_secret: secret, poll_interval_seconds: POLL_INTERVAL_SECONDS, server_time: new Date().toISOString() }
}

/* ── device authentication ─────────────────────────────────────────────── */

/** `Authorization: Bearer <device_id>.<secret>` → the active device, or 401. */
export async function authenticateDevice(headers: Headers, ip: string | null): Promise<AgentDevice> {
  const parsed = parseDeviceAuth(headers.get("authorization"))
  if (!parsed) throw unauthorized()
  const d = await q1<{ id: string; tenant_id: string; hostname: string; os_family: OsFamily; group_id: string | null; status: string; secret_hash: string; reboot_pending: boolean }>(
    "select id, tenant_id, hostname, os_family, group_id, status, secret_hash, reboot_pending from devices where id = $1",
    [parsed.deviceId]
  )
  const matches = safeEqual(sha256Hex(parsed.secret), d?.secret_hash ?? DUMMY_HASH)
  if (!d || !matches || d.status !== "active") throw unauthorized()
  await exec(
    "update devices set last_seen_at = now(), last_ip = coalesce($2, last_ip) where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '1 minute')",
    [d.id, ip]
  )
  return { id: d.id, tenantId: d.tenant_id, hostname: d.hostname, osFamily: d.os_family, groupId: d.group_id, rebootPending: d.reboot_pending }
}

/* ── heartbeat ─────────────────────────────────────────────────────────── */

async function pendingJobCount(db: Db | undefined, device: AgentDevice): Promise<number> {
  const row = await q1<{ n: number }>(
    "select count(*) as n from agent_jobs where device_id = $1 and tenant_id = $2 and status = 'queued' and not_before <= now() and (expires_at is null or expires_at > now())",
    [device.id, device.tenantId],
    db
  )
  return row?.n ?? 0
}

export async function recordHeartbeat(device: AgentDevice, raw: unknown, ip: string | null) {
  const input = parse(heartbeatSchema, raw)
  await exec(
    `update devices set agent_version = coalesce($3, agent_version), hostname = coalesce($4, hostname), logged_on_user = $5,
            uptime_seconds = coalesce($6, uptime_seconds), reboot_pending = coalesce($7, reboot_pending),
            ip_addresses = coalesce($8::text[], ip_addresses), last_seen_at = now(), last_ip = coalesce($9, last_ip), updated_at = now()
      where id = $1 and tenant_id = $2`,
    [
      device.id,
      device.tenantId,
      input.agent_version,
      input.hostname,
      input.logged_on_user,
      input.uptime_seconds === null ? null : Math.max(0, Math.round(input.uptime_seconds)),
      input.reboot_pending,
      input.ip_addresses ?? null,
      ip,
    ]
  )
  return { poll_interval_seconds: POLL_INTERVAL_SECONDS, jobs_pending: await pendingJobCount(undefined, device), server_time: new Date().toISOString() }
}

/* ── inventory ─────────────────────────────────────────────────────────── */

const round = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v))
const int4 = (v: number | null | undefined) => {
  const n = round(v)
  return n === null || n < 0 || n > 2147483647 ? null : n
}

export async function ingestInventory(device: AgentDevice, raw: unknown): Promise<{ ok: true }> {
  const input = parse(inventorySchema, raw)
  // a body without a "software" key leaves the software list alone
  const replaceSoftware = !!raw && typeof raw === "object" && "software" in raw && (raw as Record<string, unknown>).software !== null
  const hw = input.hardware ?? null
  const os = input.os ?? null
  const net = input.network ?? null
  const disks = hw?.disks ?? []
  const sum = (k: "size_gb" | "free_gb") => (disks.length ? Math.round(disks.reduce((a, d) => a + Math.max(0, d[k] ?? 0), 0) * 10) / 10 : null)
  const software = new Map<string, { name: string; version: string; publisher: string | null; installed_on: string | null }>()
  for (const s of input.software) {
    if (!s.name) continue
    const version = s.version ?? ""
    software.set(`${s.name}\u0001${version}`, { name: s.name, version, publisher: s.publisher, installed_on: s.installed_on })
  }
  const snapshot = cleanJson({ hardware: hw, os, network: net, software_count: software.size, received_at: new Date().toISOString() })

  const dev = await withRetry(() =>
    tx(async (db) => {
      const row = await q1<{
        hostname: string
        os_family: string
        os_name: string | null
        manufacturer: string | null
        model: string | null
        serial_no: string | null
        cpu: string | null
        ram_mb: number | null
        mac_addresses: string[]
        ip_addresses: string[]
      }>(
        `update devices set
            manufacturer = coalesce($3, manufacturer), model = coalesce($4, model), serial_no = coalesce($5, serial_no),
            cpu = coalesce($6, cpu), cpu_cores = coalesce($7, cpu_cores), ram_mb = coalesce($8, ram_mb),
            disk_total_gb = coalesce($9, disk_total_gb), disk_free_gb = coalesce($10, disk_free_gb),
            os_name = coalesce($11, os_name), os_version = coalesce($12, os_version), os_build = coalesce($13, os_build),
            arch = coalesce($14, arch), domain = coalesce($15, domain),
            mac_addresses = coalesce($16::text[], mac_addresses), ip_addresses = coalesce($17::text[], ip_addresses),
            inventory = $18, last_inventory_at = now(), updated_at = now()
          where id = $1 and tenant_id = $2
          returning hostname, os_family, os_name, manufacturer, model, serial_no, cpu, ram_mb, mac_addresses, ip_addresses`,
        [
          device.id,
          device.tenantId,
          hw?.manufacturer ?? null,
          hw?.model ?? null,
          hw?.serial_no ?? null,
          hw?.cpu ?? null,
          int4(hw?.cpu_cores),
          int4(hw?.ram_mb),
          sum("size_gb"),
          sum("free_gb"),
          os?.name ?? null,
          os?.version ?? null,
          os?.build ?? null,
          os?.arch ?? null,
          os?.domain ?? null,
          net?.mac_addresses ?? null,
          net?.ip_addresses ?? null,
          JSON.stringify(snapshot),
        ],
        db
      )
      if (!row) throw unauthorized()
      if (replaceSoftware) {
        await exec("delete from device_software where device_id = $1", [device.id], db)
        const list = [...software.values()]
        if (list.length) {
          await exec(
            `insert into device_software (device_id, name, version, publisher, installed_on)
             select $1, x.name, x.version, x.publisher, x.installed_on
               from unnest($2::text[], $3::text[], $4::text[], $5::date[]) as x(name, version, publisher, installed_on)
             on conflict do nothing`,
            [device.id, list.map((s) => s.name), list.map((s) => s.version), list.map((s) => s.publisher), list.map((s) => s.installed_on)],
            db
          )
        }
      }
      return row
    })
  )

  await linkDeviceToCi(device.tenantId, device.id, {
    hostname: dev.hostname,
    os_family: dev.os_family,
    os_name: dev.os_name,
    manufacturer: dev.manufacturer,
    model: dev.model,
    serial_no: dev.serial_no,
    cpu: dev.cpu,
    ram_mb: dev.ram_mb,
    mac_addresses: dev.mac_addresses ?? [],
    ip_addresses: dev.ip_addresses ?? [],
  })
  return { ok: true }
}

/* ── patch scan ────────────────────────────────────────────────────────── */

type ExistingPatch = {
  id: string
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
}

function normalizeKb(kb: string | null, source: string): string | null {
  if (!kb) return null
  const s = kb.trim()
  if (source === "windows_update" && /^\d{5,8}$/.test(s)) return `KB${s}`
  return s
}

/** What an existing catalog row becomes after a report: known values are not overwritten by "unknown". */
function merged(e: ExistingPatch, a: AvailablePatch & { kb: string | null }): ExistingPatch {
  return {
    ...e,
    kb: a.kb ?? e.kb,
    title: a.title ?? e.title,
    description: a.description ?? e.description,
    classification: a.classification === "other" ? e.classification : a.classification,
    severity: a.severity === "unspecified" ? e.severity : a.severity,
    version: a.version ?? e.version,
    release_date: a.release_date ?? e.release_date,
    size_bytes: a.size_bytes === null ? e.size_bytes : Math.max(0, Math.round(a.size_bytes)),
    reboot_required: a.reboot_required ?? e.reboot_required,
    support_url: a.support_url ?? e.support_url,
  }
}

const PATCH_FIELDS = ["kb", "title", "description", "classification", "severity", "version", "release_date", "size_bytes", "reboot_required", "support_url"] as const

async function existingPatches(db: Db, tenantId: string, os: string, source: string, ids: string[]): Promise<Map<string, ExistingPatch>> {
  if (!ids.length) return new Map()
  const rows = await q<ExistingPatch>(
    `select id, external_id, kb, title, description, classification, severity, version, release_date, size_bytes, reboot_required, support_url
       from patches where tenant_id = $1 and os_family = $2 and source = $3 and external_id = any($4::text[])`,
    [tenantId, os, source, ids],
    db
  )
  return new Map(rows.map((r) => [r.external_id, r]))
}

export async function ingestPatchScan(device: AgentDevice, raw: unknown): Promise<{ ok: true; missing: number }> {
  const input = parse(patchScanSchema, raw)
  const source = input.source
  const os = osFamilyForSource(source)

  // de-duplicate (first entry wins); sorted by external_id so concurrent scans lock catalog rows in the same order
  const available = new Map<string, AvailablePatch & { kb: string | null }>()
  for (const a of input.available) if (!available.has(a.external_id)) available.set(a.external_id, { ...a, kb: normalizeKb(a.kb, source) })
  const installed = new Map<string, { external_id: string; kb: string | null; title: string | null; installed_on: string | null }>()
  for (const i of input.installed) if (!available.has(i.external_id) && !installed.has(i.external_id)) installed.set(i.external_id, { ...i, kb: normalizeKb(i.kb, source) })
  const availList = [...available.values()].sort((a, b) => (a.external_id < b.external_id ? -1 : 1))
  const instList = [...installed.values()].sort((a, b) => (a.external_id < b.external_id ? -1 : 1))

  return withRetry(() =>
    tx(async (db) => {
      const dev = await q1<{ reboot_pending: boolean }>("select reboot_pending from devices where id = $1 and tenant_id = $2 for update", [device.id, device.tenantId], db)
      if (!dev) throw unauthorized()

      /* catalog: insert new patches, update changed ones */
      const known = await existingPatches(db, device.tenantId, os, source, [...available.keys(), ...installed.keys()])
      const fresh = availList.filter((a) => !known.has(a.external_id))
      if (fresh.length) {
        await exec(
          `insert into patches (tenant_id, os_family, source, external_id, kb, title, description, classification, severity, version, release_date, size_bytes, reboot_required, support_url)
           select $1, $2, $3, x.external_id, x.kb, x.title, x.description, x.classification, x.severity, x.version, x.release_date, x.size_bytes, x.reboot_required, x.support_url
             from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::date[], $12::bigint[], $13::boolean[], $14::text[])
                  as x(external_id, kb, title, description, classification, severity, version, release_date, size_bytes, reboot_required, support_url)
           on conflict (tenant_id, os_family, source, external_id) do nothing`,
          [
            device.tenantId,
            os,
            source,
            fresh.map((a) => a.external_id),
            fresh.map((a) => a.kb),
            fresh.map((a) => a.title ?? a.external_id),
            fresh.map((a) => a.description),
            fresh.map((a) => a.classification),
            fresh.map((a) => a.severity),
            fresh.map((a) => a.version),
            fresh.map((a) => a.release_date),
            fresh.map((a) => (a.size_bytes === null ? null : Math.max(0, Math.round(a.size_bytes)))),
            fresh.map((a) => a.reboot_required ?? false),
            fresh.map((a) => a.support_url),
          ],
          db
        )
      }
      const changed = availList
        .filter((a) => known.has(a.external_id))
        .map((a) => {
          const e = known.get(a.external_id)!
          return { before: e, after: merged(e, a) }
        })
        .filter(({ before, after }) => PATCH_FIELDS.some((f) => before[f] !== after[f]))
        .map((c) => c.after)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
      if (changed.length) {
        await exec(
          `update patches p set kb = x.kb, title = x.title, description = x.description, classification = x.classification, severity = x.severity,
                  version = x.version, release_date = x.release_date, size_bytes = x.size_bytes, reboot_required = x.reboot_required,
                  support_url = x.support_url, updated_at = now()
             from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::date[], $10::bigint[], $11::boolean[], $12::text[])
                  as x(id, kb, title, description, classification, severity, version, release_date, size_bytes, reboot_required, support_url)
            where p.id = x.id and p.tenant_id = $1`,
          [
            device.tenantId,
            changed.map((c) => c.id),
            changed.map((c) => c.kb),
            changed.map((c) => c.title),
            changed.map((c) => c.description),
            changed.map((c) => c.classification),
            changed.map((c) => c.severity),
            changed.map((c) => c.version),
            changed.map((c) => c.release_date),
            changed.map((c) => c.size_bytes),
            changed.map((c) => c.reboot_required),
            changed.map((c) => c.support_url),
          ],
          db
        )
      }
      const newInstalled = instList.filter((i) => !known.has(i.external_id))
      if (newInstalled.length) {
        await exec(
          `insert into patches (tenant_id, os_family, source, external_id, kb, title)
           select $1, $2, $3, x.external_id, x.kb, x.title from unnest($4::text[], $5::text[], $6::text[]) as x(external_id, kb, title)
           on conflict (tenant_id, os_family, source, external_id) do nothing`,
          [device.tenantId, os, source, newInstalled.map((i) => i.external_id), newInstalled.map((i) => i.kb), newInstalled.map((i) => i.title ?? i.external_id)],
          db
        )
      }
      const ids = fresh.length || newInstalled.length ? await existingPatches(db, device.tenantId, os, source, [...available.keys(), ...installed.keys()]) : known
      const availableIds = availList.map((a) => ids.get(a.external_id)?.id).filter((v): v is string => !!v)
      const installedRows = instList.map((i) => ({ id: ids.get(i.external_id)?.id, on: i.installed_on })).filter((r): r is { id: string; on: string | null } => !!r.id)

      /* device state */
      if (availableIds.length) {
        // reported available → missing; a failed install keeps its error, and a
        // pending-reboot install stays so while the device still needs the reboot
        await exec(
          `insert into device_patches (device_id, patch_id, state, detected_at, updated_at)
           select $1, x.id, 'missing', now(), now() from unnest($2::uuid[]) as x(id)
           on conflict (device_id, patch_id) do update set state = 'missing', detected_at = now(), installed_at = null, last_error = null, updated_at = now()
            where device_patches.state = 'installed' or (device_patches.state = 'pending_reboot' and not $3::boolean)`,
          [device.id, availableIds, dev.reboot_pending],
          db
        )
      }
      // previously missing from this source and not reported any more → installed
      await exec(
        `update device_patches dp set state = 'installed', installed_at = coalesce(dp.installed_at, now()), last_error = null, updated_at = now()
           from patches p
          where dp.device_id = $1 and dp.patch_id = p.id and p.tenant_id = $2 and p.source = $3 and p.os_family = $4
            and dp.state in ('missing', 'failed', 'pending_reboot') and not (dp.patch_id = any($5::uuid[]))`,
        [device.id, device.tenantId, source, os, availableIds],
        db
      )
      if (installedRows.length) {
        await exec(
          `insert into device_patches (device_id, patch_id, state, installed_at, detected_at, updated_at)
           select $1, x.id, 'installed', coalesce(x.inst_on::timestamptz, now()), now(), now() from unnest($2::uuid[], $3::date[]) as x(id, inst_on)
           on conflict (device_id, patch_id) do update set state = 'installed', installed_at = coalesce(device_patches.installed_at, excluded.installed_at),
                  last_error = null, updated_at = now()
            where device_patches.state <> 'installed'`,
          [device.id, installedRows.map((r) => r.id), installedRows.map((r) => r.on)],
          db
        )
      }
      await exec("update devices set last_scan_at = now(), updated_at = now() where id = $1 and tenant_id = $2", [device.id, device.tenantId], db)
      await applyAutoApproval(db, device.tenantId, { deviceId: device.id })
      const missing = await q1<{ n: number }>(
        `select count(*) as n from device_patches dp join patches p on p.id = dp.patch_id
          where dp.device_id = $1 and p.tenant_id = $2 and dp.state in ('missing', 'failed') and p.approval <> 'declined'`,
        [device.id, device.tenantId],
        db
      )
      return { ok: true as const, missing: missing?.n ?? 0 }
    })
  )
}

/* ── jobs ──────────────────────────────────────────────────────────────── */

export type ClaimedJob = { id: string; kind: string; payload: Record<string, unknown> }

/** Claims queued, due, unexpired jobs (marks them dispatched). */
export async function claimJobs(device: AgentDevice, limit = 10): Promise<ClaimedJob[]> {
  const rows = await q<ClaimedJob & { not_before: Date; created_at: Date }>(
    `update agent_jobs set status = 'dispatched', dispatched_at = now()
      where id in (
        select id from agent_jobs
         where device_id = $1 and tenant_id = $2 and status = 'queued' and not_before <= now() and (expires_at is null or expires_at > now())
         order by not_before, created_at
         limit $3
         for update skip locked)
      returning id, kind, payload, not_before, created_at`,
    [device.id, device.tenantId, limit]
  )
  return rows
    .sort((a, b) => a.not_before.getTime() - b.not_before.getTime() || a.created_at.getTime() - b.created_at.getTime())
    .map((r) => ({ id: r.id, kind: r.kind, payload: r.payload ?? {} }))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

/** Long poll: returns as soon as jobs are claimed, or after `waitSeconds` (max 30) with none. */
export async function pollJobs(device: AgentDevice, waitSeconds: number, signal?: AbortSignal): Promise<ClaimedJob[]> {
  const deadline = Date.now() + Math.min(MAX_WAIT_SECONDS, Math.max(0, waitSeconds)) * 1000
  for (;;) {
    if (signal?.aborted) return []
    const jobs = await claimJobs(device)
    if (jobs.length) return jobs
    const left = deadline - Date.now()
    if (left <= 0) return []
    await sleep(Math.min(1500, left), signal)
  }
}

type JobRow = { id: string; kind: string; status: string; payload: Record<string, unknown>; deployment_id: string | null }

/** Progress and result of a job from the agent. 404 for a job of another device, 409 when cancelled. */
export async function updateJobFromAgent(device: AgentDevice, jobId: string, raw: unknown): Promise<{ ok: true }> {
  if (!isUuid(jobId)) throw notFound("Job not found")
  const input = parse(jobUpdateSchema, raw)
  await withRetry(() =>
    tx(async (db) => {
      const job = await q1<JobRow>(
        "select id, kind, status, payload, deployment_id from agent_jobs where id = $1 and device_id = $2 and tenant_id = $3 for update",
        [jobId, device.id, device.tenantId],
        db
      )
      if (!job) throw notFound("Job not found")
      if (job.status === "cancelled") throw new AppError("The job was cancelled", 409, "cancelled")

      if (input.status === "running") {
        // never move a finished job backwards
        await exec(
          `update agent_jobs set status = 'running', started_at = coalesce(started_at, now()), dispatched_at = coalesce(dispatched_at, now())
            where id = $1 and status in ('queued', 'dispatched', 'running', 'expired')`,
          [job.id],
          db
        )
        return
      }

      const output = input.output === null ? null : truncateUtf8(input.output)
      await exec(
        `update agent_jobs set status = $2, finished_at = now(), started_at = coalesce(started_at, dispatched_at, now()),
                exit_code = $3, output = $4, result = $5
          where id = $1`,
        [job.id, input.status, input.exit_code, output, input.result ? JSON.stringify(cleanJson(input.result)) : null],
        db
      )
      if (job.kind === "install_patches") await applyInstallResults(db, device, job, input.status, input.result, input.exit_code, output)
      if (job.deployment_id) await maybeCompleteDeployment(db, device.tenantId, job.deployment_id)
    })
  )
  return { ok: true }
}

async function applyInstallResults(
  db: Db,
  device: AgentDevice,
  job: JobRow,
  status: "succeeded" | "failed",
  result: Record<string, unknown> | null,
  exitCode: number | null,
  output: string | null
) {
  const res = parseInstallResult(result)
  const planned = (Array.isArray(job.payload?.patches) ? job.payload.patches : []) as JobPatch[]
  const byExternal = new Map<string, string>()
  for (const p of planned) if (p && typeof p.external_id === "string" && isUuid(p.patch_id)) byExternal.set(p.external_id, p.patch_id)

  const unknown = res.results.map((r) => r.external_id).filter((id) => !byExternal.has(id))
  if (unknown.length) {
    const rows = await q<{ id: string; external_id: string }>(
      `select id, external_id from patches where tenant_id = $1 and external_id = any($2::text[]) ${device.osFamily === "other" ? "" : "and os_family = $3"}`,
      device.osFamily === "other" ? [device.tenantId, unknown] : [device.tenantId, unknown, device.osFamily],
      db
    )
    for (const r of rows) if (!byExternal.has(r.external_id)) byExternal.set(r.external_id, r.id)
  }

  const updates = res.results
    .map((r) => ({ id: byExternal.get(r.external_id), state: r.status, error: r.status === "failed" ? r.error ?? "Installation failed" : null }))
    .filter((u): u is { id: string; state: "installed" | "failed" | "pending_reboot"; error: string | null } => !!u.id)

  if (!updates.length && status === "failed" && planned.length) {
    // the whole job failed without per-patch results: record it on the patches it was meant to install
    const firstLine = (output ?? "").split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 300)
    const error = `Install job failed${exitCode !== null ? ` (exit code ${exitCode})` : ""}${firstLine ? `: ${firstLine}` : ""}`
    for (const p of planned) if (isUuid(p.patch_id)) updates.push({ id: p.patch_id, state: "failed", error })
  }

  const seen = new Set<string>()
  const unique = updates.filter((u) => !seen.has(u.id) && !!seen.add(u.id))
  if (unique.length) {
    await exec(
      `insert into device_patches (device_id, patch_id, state, installed_at, last_error, detected_at, updated_at)
       select $1, x.id, x.state, case when x.state = 'installed' then now() end, x.err, now(), now()
         from unnest($2::uuid[], $3::text[], $4::text[]) as x(id, state, err)
        where exists (select 1 from patches p where p.id = x.id and p.tenant_id = $5)
       on conflict (device_id, patch_id) do update set
         state = excluded.state,
         installed_at = case when excluded.state = 'installed' then coalesce(device_patches.installed_at, now()) else device_patches.installed_at end,
         last_error = excluded.last_error,
         updated_at = now()
        where device_patches.state <> 'installed' or excluded.state = 'installed'`,
      [device.id, unique.map((u) => u.id), unique.map((u) => u.state), unique.map((u) => u.error), device.tenantId],
      db
    )
  }
  if (res.reboot_required || unique.some((u) => u.state === "pending_reboot")) {
    await exec("update devices set reboot_pending = true, updated_at = now() where id = $1 and tenant_id = $2", [device.id, device.tenantId], db)
  }
}

/* ── offline packages ──────────────────────────────────────────────────── */

export async function packageForDevice(device: AgentDevice, patchId: string) {
  if (!isUuid(patchId)) throw notFound("Package not found")
  const f = await q1<{ storage_key: string | null; file_name: string; sha256: string | null; size_bytes: number; scan_status: string }>(
    `select f.storage_key, f.file_name, f.sha256, f.size_bytes, f.scan_status
       from patches p join files f on f.id = p.package_file_id and f.tenant_id = p.tenant_id
      where p.id = $1 and p.tenant_id = $2`,
    [patchId, device.tenantId]
  )
  if (!f || !f.storage_key) throw notFound("This patch has no offline package")
  if (f.scan_status === "infected") throw new AppError("The package was blocked by the virus scanner", 403, "blocked")
  return { storageKey: f.storage_key, fileName: f.file_name, sha256: f.sha256, size: f.size_bytes }
}
