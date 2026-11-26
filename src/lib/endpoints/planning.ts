/**
 * Pure planning logic: policy schedule slots and the per-device patch lists of
 * install_patches jobs. No I/O, unit-tested.
 */
import { isValidTimeZone, wallToInstant, zoned } from "@/lib/itsm/clock"
import type { RebootBehavior } from "@/lib/endpoints/vocab"

/* ── policy schedule slots ─────────────────────────────────────────────── */

/** "HH:MM" or "HH:MM:SS" → hours and minutes (null when malformed). */
export function parseTimeOfDay(v: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return { h, m: mi }
}

/**
 * The most recent scheduled instant at or before `now`: a weekday in `days`
 * (0 = Sunday) at `time`, wall-clock in `tz`. Null when no days are set.
 */
export function latestSlot(days: number[], time: string, tz: string, now: Date): Date | null {
  const set = new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))
  const t = parseTimeOfDay(time)
  if (set.size === 0 || !t) return null
  const zone = isValidTimeZone(tz) ? tz : "UTC"
  const today = zoned(now.getTime(), zone)
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d - i))
    if (!set.has(day.getUTCDay())) continue
    const at = wallToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), t.h, t.m, zone)
    if (at <= now.getTime()) return new Date(at)
  }
  return null
}

/** The next scheduled instant strictly after `now` (for display). */
export function nextSlot(days: number[], time: string, tz: string, now: Date): Date | null {
  const set = new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))
  const t = parseTimeOfDay(time)
  if (set.size === 0 || !t) return null
  const zone = isValidTimeZone(tz) ? tz : "UTC"
  const today = zoned(now.getTime(), zone)
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i))
    if (!set.has(day.getUTCDay())) continue
    const at = wallToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), t.h, t.m, zone)
    if (at > now.getTime()) return new Date(at)
  }
  return null
}

/**
 * The slot a policy should run for now, or null. A slot runs once: only when
 * it is later than the last run (or the policy's creation), and only within
 * `graceMinutes` of its time, so a server that was down does not deploy
 * hours late and a new policy does not fire for a slot that already passed.
 */
export function dueSlot(p: {
  days: number[]
  time: string
  tz: string
  lastRunAt: Date | null
  createdAt: Date
  now: Date
  graceMinutes?: number
}): Date | null {
  const slot = latestSlot(p.days, p.time, p.tz, p.now)
  if (!slot) return null
  const grace = (p.graceMinutes ?? 60) * 60_000
  if (p.now.getTime() - slot.getTime() > grace) return null
  const since = p.lastRunAt ?? p.createdAt
  if (slot.getTime() <= since.getTime()) return null
  return slot
}

/* ── install_patches payloads ──────────────────────────────────────────── */

export type PlanPatch = {
  id: string
  external_id: string
  kb: string | null
  title: string
  approval: string
  package: { sha256: string | null; file_name: string } | null
}

export type JobPatch = {
  patch_id: string
  external_id: string
  kb: string | null
  title: string
  package_url?: string
  package_sha256?: string
  package_name?: string
}

export type InstallPayload = { patches: JobPatch[]; reboot: RebootBehavior }

/**
 * Per target device, the approved patches it is missing (restricted to
 * `onlyPatchIds` when a deployment lists its patches). Devices with nothing to
 * install get no job.
 */
export function planInstallJobs(input: {
  deviceIds: string[]
  /** device_patches rows in a missing state (missing / failed) */
  missing: { device_id: string; patch_id: string }[]
  patches: Map<string, PlanPatch>
  onlyPatchIds?: string[] | null
  reboot: RebootBehavior
  appUrl: string
}): { deviceId: string; payload: InstallPayload }[] {
  const only = input.onlyPatchIds && input.onlyPatchIds.length ? new Set(input.onlyPatchIds) : null
  const targets = new Set(input.deviceIds)
  const byDevice = new Map<string, Set<string>>()
  for (const row of input.missing) {
    if (!targets.has(row.device_id)) continue
    if (only && !only.has(row.patch_id)) continue
    const p = input.patches.get(row.patch_id)
    if (!p || p.approval !== "approved") continue
    let set = byDevice.get(row.device_id)
    if (!set) byDevice.set(row.device_id, (set = new Set()))
    set.add(row.patch_id)
  }
  const base = input.appUrl.replace(/\/+$/, "")
  const out: { deviceId: string; payload: InstallPayload }[] = []
  for (const deviceId of input.deviceIds) {
    const ids = byDevice.get(deviceId)
    if (!ids || ids.size === 0) continue
    if (out.some((o) => o.deviceId === deviceId)) continue
    const patches = [...ids]
      .map((id) => input.patches.get(id)!)
      .sort((a, b) => a.title.localeCompare(b.title) || a.external_id.localeCompare(b.external_id))
      .map((p): JobPatch => {
        const jp: JobPatch = { patch_id: p.id, external_id: p.external_id, kb: p.kb, title: p.title }
        if (p.package) {
          jp.package_url = `${base}/api/agent/v1/packages/${p.id}`
          if (p.package.sha256) jp.package_sha256 = p.package.sha256
          jp.package_name = p.package.file_name
        }
        return jp
      })
    out.push({ deviceId, payload: { patches, reboot: input.reboot } })
  }
  return out
}
