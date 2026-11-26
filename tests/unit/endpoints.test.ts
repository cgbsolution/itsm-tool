import { describe, expect, it } from "vitest"
import {
  enrollSchema,
  heartbeatSchema,
  inventorySchema,
  jobUpdateSchema,
  normalizeClassification,
  normalizeDate,
  normalizeSeverity,
  parseDeviceAuth,
  parseInstallResult,
  parseWait,
  patchScanSchema,
  requestIp,
  toInt32,
  truncateUtf8,
  cleanJson,
} from "@/lib/endpoints/protocol"
import { dueSlot, latestSlot, nextSlot, parseTimeOfDay, planInstallJobs, type PlanPatch } from "@/lib/endpoints/planning"
import { parse } from "@/lib/validate"
import { formatUptime, osFamilyForSource, safeHttpUrl, shellsFor } from "@/lib/endpoints/vocab"

const DEVICE = "5e7c7b3c-a190-4d65-9222-90779d1b6937"

describe("device auth header", () => {
  it("parses Bearer <device_id>.<secret>", () => {
    expect(parseDeviceAuth(`Bearer ${DEVICE}.T5gU0-vKzM6dgIev-bncW8rtPcXzut5fgPyprFjpVDs`)).toEqual({
      deviceId: DEVICE,
      secret: "T5gU0-vKzM6dgIev-bncW8rtPcXzut5fgPyprFjpVDs",
    })
    expect(parseDeviceAuth(`bearer   ${DEVICE.toUpperCase()}.abcdefghijklmnopqrstuvwxyz `)?.deviceId).toBe(DEVICE)
  })
  it("rejects anything else", () => {
    expect(parseDeviceAuth(null)).toBeNull()
    expect(parseDeviceAuth("")).toBeNull()
    expect(parseDeviceAuth(`Basic ${DEVICE}.abcdefghijklmnopqrstuvwxyz`)).toBeNull()
    expect(parseDeviceAuth(`Bearer ${DEVICE}`)).toBeNull()
    expect(parseDeviceAuth(`Bearer ${DEVICE}.short`)).toBeNull()
    expect(parseDeviceAuth("Bearer not-a-uuid.abcdefghijklmnopqrstuvwxyz")).toBeNull()
    expect(parseDeviceAuth(`Bearer ${DEVICE}.abc def ghijklmnopqrstuvwxyz`)).toBeNull()
    expect(parseDeviceAuth(`Bearer ${DEVICE}.abcdefghij.klmnopqrstuvwxyz`)).toBeNull()
    expect(parseDeviceAuth("Bearer itsm_pat_abcdefghijklmnopqrstuvwxyz")).toBeNull()
  })
})

describe("small protocol helpers", () => {
  it("clamps the long-poll wait", () => {
    expect(parseWait(null)).toBe(25)
    expect(parseWait("2")).toBe(2)
    expect(parseWait("120")).toBe(30)
    expect(parseWait("-5")).toBe(0)
    expect(parseWait("abc")).toBe(25)
  })
  it("reads the client address from proxy headers", () => {
    expect(requestIp(new Headers({ "x-forwarded-for": "10.0.0.5, 172.16.0.1" }))).toBe("10.0.0.5")
    expect(requestIp(new Headers({ "x-real-ip": "10.0.0.6" }))).toBe("10.0.0.6")
    expect(requestIp(new Headers())).toBeNull()
  })
  it("normalises dates from agents", () => {
    expect(normalizeDate("2026-11-02")).toBe("2026-11-02")
    expect(normalizeDate("20260105")).toBe("2026-01-05")
    expect(normalizeDate("2026-11-11T10:00:00Z")).toBe("2026-11-11")
    expect(normalizeDate("/Date(1762819200000)/")).toBe("2025-11-11")
    expect(normalizeDate("2026-02-31")).toBeNull()
    expect(normalizeDate("yesterday")).toBeNull()
    expect(normalizeDate("")).toBeNull()
    expect(normalizeDate(null)).toBeNull()
  })
  it("maps classification and severity words", () => {
    expect(normalizeClassification("Security Updates")).toBe("security")
    expect(normalizeClassification("Critical Updates")).toBe("critical")
    expect(normalizeClassification("Definition Updates")).toBe("definition")
    expect(normalizeClassification("Drivers")).toBe("driver")
    expect(normalizeClassification("update")).toBe("update")
    expect(normalizeClassification("Feature Packs")).toBe("feature")
    expect(normalizeClassification("weird")).toBe("other")
    expect(normalizeSeverity("Critical")).toBe("critical")
    expect(normalizeSeverity("")).toBe("unspecified")
    expect(normalizeSeverity(undefined)).toBe("unspecified")
  })
  it("fits exit codes into int4", () => {
    expect(toInt32(0)).toBe(0)
    expect(toInt32(2149842978)).toBe(-2145124318) // 0x80240022 unsigned → signed HRESULT
    expect(toInt32(1e12)).toBe(2147483647)
    expect(toInt32(null)).toBeNull()
  })
  it("truncates output to 64 KB without splitting characters and strips NULs", () => {
    const s = "é".repeat(40_000) // 80 000 bytes
    const t = truncateUtf8(s)
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(64 * 1024)
    expect(t.endsWith("é")).toBe(true)
    expect(truncateUtf8("a\u0000b")).toBe("ab")
    expect(cleanJson({ "k\u0000": ["x\u0000y", 1, null] })).toEqual({ k: ["xy", 1, null] })
  })
  it("knows OS families, shells and safe links", () => {
    expect(osFamilyForSource("windows_update")).toBe("windows")
    expect(osFamilyForSource("apt")).toBe("linux")
    expect(osFamilyForSource("macos")).toBe("macos")
    expect(shellsFor("windows")).toEqual(["powershell", "cmd"])
    expect(shellsFor("linux")).toEqual(["bash", "sh"])
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull()
    expect(safeHttpUrl("https://x.test/a")).toBe("https://x.test/a")
    expect(formatUptime(12345)).toBe("3 h 25 min")
    expect(formatUptime(200_000)).toBe("2 d 7 h")
  })
})

describe("payload validation", () => {
  it("accepts the documented enrol body and cleans it", () => {
    const e = parse(enrollSchema, {
      token: "enr_xxxxxxxxxxxxxxxx",
      hostname: " LAPTOP-042 ",
      os_family: "Windows",
      os_name: "Microsoft Windows 11 Pro",
      os_version: "10.0.26100",
      arch: "x64",
      agent_version: "1.0.0",
      serial_no: "PF3ABC12",
      mac_addresses: ["00:11:22:33:44:55"],
      extra: "ignored",
    })
    expect(e.hostname).toBe("LAPTOP-042")
    expect(e.os_family).toBe("windows")
    expect(e.mac_addresses).toEqual(["00:11:22:33:44:55"])
    expect("extra" in e).toBe(false)
    // optional fields may be missing; a single string becomes a one-item list (PowerShell)
    const min = parse(enrollSchema, { token: "enr_xxxxxxxxxxxxxxxx", hostname: "srv1", os_family: "linux", mac_addresses: "aa:bb" })
    expect(min.serial_no).toBeNull()
    expect(min.mac_addresses).toEqual(["aa:bb"])
  })
  it("rejects bad enrol bodies", () => {
    expect(() => parse(enrollSchema, { token: "enr_xxxxxxxxxxxxxxxx", hostname: "", os_family: "windows" })).toThrow(/hostname/)
    expect(() => parse(enrollSchema, { token: "enr_xxxxxxxxxxxxxxxx", hostname: "a", os_family: "beos" })).toThrow(/os_family/)
    expect(() => parse(enrollSchema, { hostname: "a", os_family: "linux" })).toThrow(/token/)
    expect(() => parse(enrollSchema, { token: "enr_xxxxxxxxxxxxxxxx", hostname: "x".repeat(256), os_family: "linux" })).toThrow()
  })
  it("accepts a heartbeat with missing fields as 'unchanged'", () => {
    const h = parse(heartbeatSchema, { agent_version: "1.0.0" })
    expect(h.ip_addresses).toBeUndefined()
    expect(h.reboot_pending).toBeNull()
    expect(h.uptime_seconds).toBeNull()
    const full = parse(heartbeatSchema, { logged_on_user: "CORP\\asha", uptime_seconds: "12345", reboot_pending: "true", ip_addresses: ["10.0.0.12"] })
    expect(full).toMatchObject({ logged_on_user: "CORP\\asha", uptime_seconds: 12345, reboot_pending: true, ip_addresses: ["10.0.0.12"] })
    expect(() => parse(heartbeatSchema, { uptime_seconds: "soon" })).toThrow()
  })
  it("accepts the documented inventory and caps software", () => {
    const inv = parse(inventorySchema, {
      hardware: { manufacturer: "Dell Inc.", model: "Latitude 7440", serial_no: "PF3ABC12", cpu: "i7", cpu_cores: 10, ram_mb: 16384, disks: [{ name: "C:", size_gb: 476.3, free_gb: 210.1 }] },
      os: { name: "Microsoft Windows 11 Pro", version: "10.0.26100", build: "26100.2314", arch: "x64", domain: "CORP", install_date: "2025-01-10" },
      network: { mac_addresses: ["00:11:22:33:44:55"], ip_addresses: ["10.0.0.12"] },
      software: [{ name: "Google Chrome", version: "131.0.6778.86", publisher: "Google LLC", installed_on: "2026-11-02" }],
    })
    expect(inv.hardware?.disks).toHaveLength(1)
    expect(inv.software[0]).toEqual({ name: "Google Chrome", version: "131.0.6778.86", publisher: "Google LLC", installed_on: "2026-11-02" })
    expect(parse(inventorySchema, { software: { name: "Only one" } }).software).toHaveLength(1)
    expect(parse(inventorySchema, {}).software).toEqual([])
    const many = Array.from({ length: 20_001 }, (_, i) => ({ name: `p${i}` }))
    expect(() => parse(inventorySchema, { software: many })).toThrow(/Too many|at most/)
    expect(parse(inventorySchema, { software: [{ name: "x".repeat(1000) }] }).software[0].name).toHaveLength(300)
  })
  it("accepts the documented patch scan and normalises values", () => {
    const s = parse(patchScanSchema, {
      source: "windows_update",
      scanned_at: "2026-11-26T10:00:00Z",
      available: [
        { external_id: "c2b0f9a2", kb: "KB5046617", title: "2026-11 CU", classification: "security", severity: "critical", version: "", size_bytes: 123456789, reboot_required: true, release_date: "2026-11-11", description: "...", support_url: "https://x" },
        { external_id: "d1", title: "Defender", classification: "Definition Updates" },
      ],
      installed: [{ external_id: "a1", kb: "KB5044284", title: "old", installed_on: "2026-10-10" }],
    })
    expect(s.scanned_at?.toISOString()).toBe("2026-11-26T10:00:00.000Z")
    expect(s.available[0]).toMatchObject({ external_id: "c2b0f9a2", classification: "security", severity: "critical", version: null, release_date: "2026-11-11", reboot_required: true })
    expect(s.available[1]).toMatchObject({ classification: "definition", severity: "unspecified", release_date: null, size_bytes: null, reboot_required: null })
    expect(s.installed[0].installed_on).toBe("2026-10-10")
    expect(parse(patchScanSchema, { source: "apt" })).toMatchObject({ available: [], installed: [], scanned_at: null })
  })
  it("rejects bad patch scans", () => {
    expect(() => parse(patchScanSchema, { source: "nope", available: [] })).toThrow(/source/)
    expect(() => parse(patchScanSchema, { source: "apt", available: [{ title: "no id" }] })).toThrow(/external_id/)
    expect(() => parse(patchScanSchema, { source: "apt", available: [{ external_id: "x".repeat(301) }] })).toThrow()
    const many = Array.from({ length: 5001 }, (_, i) => ({ external_id: `p${i}` }))
    expect(() => parse(patchScanSchema, { source: "apt", available: many })).toThrow()
  })
  it("validates job updates", () => {
    expect(parse(jobUpdateSchema, { status: "running" })).toEqual({ status: "running", exit_code: null, output: null, result: null })
    const done = parse(jobUpdateSchema, { status: "succeeded", exit_code: 0, output: "ok", result: { results: [], reboot_required: false } })
    expect(done).toMatchObject({ status: "succeeded", exit_code: 0, output: "ok" })
    expect(() => parse(jobUpdateSchema, { status: "done" })).toThrow(/status/)
    expect(() => parse(jobUpdateSchema, { status: "failed", result: "nope" })).toThrow()
  })
  it("reads install results defensively", () => {
    const r = parseInstallResult({
      results: [
        { external_id: "a", status: "installed", error: null },
        { external_id: "b", status: "failed", error: "0x80240022" },
        { external_id: "c", status: "pending_reboot" },
        { external_id: "a", status: "failed" },
        { external_id: "d", status: "weird" },
        "junk",
      ],
      reboot_required: true,
    })
    expect(r.reboot_required).toBe(true)
    expect(r.results).toEqual([
      { external_id: "a", status: "installed", error: null },
      { external_id: "b", status: "failed", error: "0x80240022" },
      { external_id: "c", status: "pending_reboot", error: null },
      { external_id: "d", status: "failed", error: 'Unknown status "weird"' },
    ])
    expect(parseInstallResult(null)).toEqual({ results: [], reboot_required: false })
  })
})

describe("policy schedule slots", () => {
  const at = (iso: string) => new Date(iso)
  it("parses times of day", () => {
    expect(parseTimeOfDay("02:00")).toEqual({ h: 2, m: 0 })
    expect(parseTimeOfDay("23:59:00")).toEqual({ h: 23, m: 59 })
    expect(parseTimeOfDay("24:00")).toBeNull()
    expect(parseTimeOfDay("2am")).toBeNull()
  })
  it("finds the latest slot in the tenant time zone", () => {
    // Thursday 2026-11-26 10:00 UTC = 15:30 in Asia/Kolkata
    const now = at("2026-11-26T10:00:00Z")
    // every day 02:00 Kolkata = 2026-11-25T20:30Z
    expect(latestSlot([0, 1, 2, 3, 4, 5, 6], "02:00", "Asia/Kolkata", now)?.toISOString()).toBe("2026-11-25T20:30:00.000Z")
    // Tuesdays (2) 02:00 UTC → 2026-11-24
    expect(latestSlot([2], "02:00", "UTC", now)?.toISOString()).toBe("2026-11-24T02:00:00.000Z")
    // Thursday 18:00 UTC is later today → last week's
    expect(latestSlot([4], "18:00", "UTC", now)?.toISOString()).toBe("2026-11-19T18:00:00.000Z")
    expect(latestSlot([], "02:00", "UTC", now)).toBeNull()
    expect(nextSlot([4], "18:00", "UTC", now)?.toISOString()).toBe("2026-11-26T18:00:00.000Z")
    // invalid zone falls back to UTC
    expect(latestSlot([2], "02:00", "Mars/Olympus", now)?.toISOString()).toBe("2026-11-24T02:00:00.000Z")
  })
  it("handles daylight saving (America/New_York, 2026-11-01 ends DST)", () => {
    // Sunday 2026-11-01 03:00 local is EST (UTC-5) → 08:00Z; Saturday 03:00 is EDT (UTC-4) → 07:00Z
    expect(latestSlot([0], "03:00", "America/New_York", at("2026-11-01T12:00:00Z"))?.toISOString()).toBe("2026-11-01T08:00:00.000Z")
    expect(latestSlot([6], "03:00", "America/New_York", at("2026-11-01T12:00:00Z"))?.toISOString()).toBe("2026-10-31T07:00:00.000Z")
  })
  it("runs each slot once, within the grace period, and not before the policy existed", () => {
    const base = { days: [4], time: "10:00", tz: "UTC", createdAt: at("2026-11-01T00:00:00Z") }
    // 10 minutes after the slot, never run → due
    expect(dueSlot({ ...base, lastRunAt: null, now: at("2026-11-26T10:10:00Z") })?.toISOString()).toBe("2026-11-26T10:00:00.000Z")
    // already ran for this slot
    expect(dueSlot({ ...base, lastRunAt: at("2026-11-26T10:05:00Z"), now: at("2026-11-26T10:10:00Z") })).toBeNull()
    // ran last week → due again
    expect(dueSlot({ ...base, lastRunAt: at("2026-11-19T10:05:00Z"), now: at("2026-11-26T10:10:00Z") })).not.toBeNull()
    // too late (server was down): skip, wait for next slot
    expect(dueSlot({ ...base, lastRunAt: null, now: at("2026-11-26T12:30:00Z") })).toBeNull()
    // policy created after the slot passed
    expect(dueSlot({ ...base, createdAt: at("2026-11-26T10:05:00Z"), lastRunAt: null, now: at("2026-11-26T10:10:00Z") })).toBeNull()
    // before the slot
    expect(dueSlot({ ...base, lastRunAt: null, now: at("2026-11-26T09:59:00Z") })).toBeNull()
  })
})

describe("per-device patch lists", () => {
  const patches = new Map<string, PlanPatch>([
    ["p1", { id: "p1", external_id: "e1", kb: "KB1", title: "B update", approval: "approved", package: null }],
    ["p2", { id: "p2", external_id: "e2", kb: null, title: "A update", approval: "approved", package: { file_name: "a.msu", sha256: "ab12" } }],
    ["p3", { id: "p3", external_id: "e3", kb: null, title: "Pending one", approval: "pending", package: null }],
    ["p4", { id: "p4", external_id: "e4", kb: null, title: "Declined one", approval: "declined", package: null }],
  ])
  const missing = [
    { device_id: "d1", patch_id: "p1" },
    { device_id: "d1", patch_id: "p2" },
    { device_id: "d1", patch_id: "p3" },
    { device_id: "d2", patch_id: "p4" },
    { device_id: "d3", patch_id: "p1" },
    { device_id: "dX", patch_id: "p1" }, // not a target
  ]
  it("lists only approved missing patches, sorted, with package links", () => {
    const plan = planInstallJobs({ deviceIds: ["d1", "d2", "d3"], missing, patches, reboot: "if_required", appUrl: "https://itsm.test/" })
    expect(plan.map((p) => p.deviceId)).toEqual(["d1", "d3"])
    expect(plan[0].payload).toEqual({
      reboot: "if_required",
      patches: [
        { patch_id: "p2", external_id: "e2", kb: null, title: "A update", package_url: "https://itsm.test/api/agent/v1/packages/p2", package_sha256: "ab12", package_name: "a.msu" },
        { patch_id: "p1", external_id: "e1", kb: "KB1", title: "B update" },
      ],
    })
  })
  it("restricts to a deployment's patches", () => {
    const plan = planInstallJobs({ deviceIds: ["d1", "d3"], missing, patches, onlyPatchIds: ["p2"], reboot: "never", appUrl: "https://itsm.test" })
    expect(plan).toHaveLength(1)
    expect(plan[0].deviceId).toBe("d1")
    expect(plan[0].payload.patches.map((p) => p.patch_id)).toEqual(["p2"])
  })
  it("returns nothing when no target misses an approved patch", () => {
    expect(planInstallJobs({ deviceIds: ["d2"], missing, patches, reboot: "always", appUrl: "x" })).toEqual([])
    expect(planInstallJobs({ deviceIds: [], missing, patches, reboot: "always", appUrl: "x" })).toEqual([])
  })
})
