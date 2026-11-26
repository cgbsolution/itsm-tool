/**
 * Endpoint and patch management against a real PostgreSQL database
 * (TEST_DATABASE_URL, default: the dev compose database `itsm_test`).
 * Runs in its own tenants, so it can run repeatedly.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://itsm:itsm_dev_password@localhost:5544/itsm_test"

const { pool, q1, q, exec } = await import("@/lib/db")
const { migrate } = await import("@/lib/db/migrate")
const { createTenant } = await import("@/lib/tenants")
const { actorForUser } = await import("@/lib/auth/session")
const { licenseStatus } = await import("@/lib/license")
const agent = await import("@/lib/endpoints/agent")
const service = await import("@/lib/endpoints/service")
const deployments = await import("@/lib/endpoints/deployments")
const jobs = await import("@/lib/endpoints/jobs")
const queries = await import("@/lib/endpoints/queries")

let reachable = true
try {
  await pool().query("select 1")
} catch {
  reachable = false
}

type A = NonNullable<Awaited<ReturnType<typeof actorForUser>>>
type Device = Awaited<ReturnType<typeof agent.authenticateDevice>>
const run = Date.now()
const ip = `test-${run}`
let tenantId = ""
let otherTenantId = ""
let pilotId = ""
let admin: A
let engineer: A

async function user(tenant: string, key: string, role: string): Promise<A> {
  const row = await q1<{ id: string }>("insert into users (tenant_id, email, full_name, role) values ($1, $2, $3, $4) returning id", [tenant, `${key}.${run}@ep.test`, key, role])
  return (await actorForUser(row!.id, "test"))!
}

const bearer = (id: string, secret: string) => new Headers({ authorization: `Bearer ${id}.${secret}` })
const patchId = async (externalId: string, tenant = tenantId) => (await q1<{ id: string }>("select id from patches where tenant_id = $1 and external_id = $2", [tenant, externalId]))!.id
const stateOf = async (deviceId: string, pid: string) =>
  (await q1<{ state: string; last_error: string | null }>("select state, last_error from device_patches where device_id = $1 and patch_id = $2", [deviceId, pid])) ?? null

const SEC = `sec-${run}`
const UPD = `upd-${run}`
const DEF = `def-${run}`
const OLD = `old-${run}`

describe.skipIf(!reachable)("endpoint and patch management (integration)", () => {
  let token = ""
  let device: Device
  let secret = ""

  beforeAll(async () => {
    await migrate()
    tenantId = await createTenant(`EP Test ${run}`, { timezone: "UTC" })
    otherTenantId = await createTenant(`EP Other ${run}`, { timezone: "UTC" })
    admin = await user(tenantId, "admin", "admin")
    engineer = await user(tenantId, "eng", "engineer")
    pilotId = (await q1<{ id: string }>("select id from device_groups where tenant_id = $1 and name = 'Pilot'", [tenantId]))!.id
  })
  afterAll(async () => {
    await pool().end()
  })

  it("creates enrolment tokens with permission checks and enrols a device", async () => {
    await expect(service.createEnrollmentToken(engineer, { name: "nope" })).rejects.toThrow(/permission/)
    const t = await service.createEnrollmentToken(admin, { name: "Test rollout", groupId: pilotId, maxUses: 2 })
    expect(t.token).toMatch(/^enr_[A-Za-z0-9_-]{32}$/)
    token = t.token
    const stored = await q1<{ token_hash: string; prefix: string }>("select token_hash, prefix from enrollment_tokens where id = $1", [t.id])
    expect(stored!.token_hash).not.toContain(token)
    expect(token.startsWith(stored!.prefix)).toBe(true)

    await expect(agent.enrollDevice({ token: "enr_wrongwrongwrongwrong", hostname: "X", os_family: "windows" }, ip)).rejects.toMatchObject({ status: 403 })
    await expect(agent.enrollDevice({ token, hostname: "", os_family: "windows" }, ip)).rejects.toMatchObject({ status: 400 })

    const e = await agent.enrollDevice({ token, hostname: "LAPTOP-042", os_family: "windows", os_name: "Windows 11 Pro", agent_version: "1.0.0", serial_no: "PF3ABC12", mac_addresses: ["00:11:22:33:44:55"] }, ip)
    expect(e.poll_interval_seconds).toBe(60)
    secret = e.device_secret
    device = await agent.authenticateDevice(bearer(e.device_id, secret), "10.0.0.12")
    expect(device.tenantId).toBe(tenantId)
    expect(device.groupId).toBe(pilotId)
    const audit = await q1<{ n: number }>("select count(*) as n from audit_log where tenant_id = $1 and action = 'endpoint.enrolled' and entity_id = $2", [tenantId, device.id])
    expect(audit!.n).toBe(1)
  })

  it("re-enrols the same host + serial with a rotated secret, then the token is used up", async () => {
    const again = await agent.enrollDevice({ token, hostname: "laptop-042", os_family: "windows", serial_no: "PF3ABC12" }, ip)
    expect(again.device_id).toBe(device.id)
    await expect(agent.authenticateDevice(bearer(device.id, secret), null)).rejects.toMatchObject({ status: 401 })
    secret = again.device_secret
    device = await agent.authenticateDevice(bearer(device.id, secret), null)
    await expect(agent.enrollDevice({ token, hostname: "OTHER", os_family: "linux" }, ip)).rejects.toMatchObject({ status: 403 })
    await expect(agent.authenticateDevice(new Headers({ authorization: `Bearer ${device.id}` }), null)).rejects.toMatchObject({ status: 401 })
  })

  it("refuses enrolment past the licence device limit (402)", async () => {
    const lic = await licenseStatus(true)
    if (lic.maxDevices > 500) return
    const t = await service.createEnrollmentToken(admin, { name: "Licence test" })
    const have = (await q1<{ n: number }>("select count(*) as n from devices where tenant_id = $1 and status = 'active'", [otherTenantId]))!.n
    // fill the other tenant up to the limit with placeholder devices
    const other = await user(otherTenantId, "admin2", "admin")
    const ot = await service.createEnrollmentToken(other, { name: "Fill" })
    await exec(
      "insert into devices (tenant_id, hostname, secret_hash) select $1, 'filler-' || g, 'x' from generate_series(1, $2::int) g",
      [otherTenantId, Math.max(0, lic.maxDevices - have)]
    )
    await expect(agent.enrollDevice({ token: ot.token, hostname: "ONE-TOO-MANY", os_family: "linux" }, ip)).rejects.toMatchObject({ status: 402 })
    // the limit is per tenant: this tenant can still enrol
    const ok = await agent.enrollDevice({ token: t.token, hostname: "SRV-01", os_family: "linux" }, ip)
    expect(ok.device_id).toBeTruthy()
    await exec("update devices set status = 'retired' where id = $1", [ok.device_id])
    await exec("update devices set status = 'retired' where tenant_id = $1", [otherTenantId])
  })

  it("records heartbeats and inventory", async () => {
    const hb = await agent.recordHeartbeat(device, { agent_version: "1.0.1", logged_on_user: "CORP\\asha", uptime_seconds: 3600, reboot_pending: false, ip_addresses: ["10.0.0.12"] }, "10.0.0.12")
    expect(hb.jobs_pending).toBe(0)
    await agent.ingestInventory(device, {
      hardware: { manufacturer: "Dell Inc.", model: "Latitude 7440", serial_no: "PF3ABC12", cpu: "i7", cpu_cores: 10, ram_mb: 16384, disks: [{ name: "C:", size_gb: 400, free_gb: 100 }, { name: "D:", size_gb: 100, free_gb: 50 }] },
      os: { name: "Microsoft Windows 11 Pro", version: "10.0.26100", build: "26100.2314", arch: "x64", domain: "CORP" },
      network: { mac_addresses: ["00:11:22:33:44:55"], ip_addresses: ["10.0.0.12"] },
      software: [
        { name: "Google Chrome", version: "131.0", publisher: "Google LLC", installed_on: "2026-11-02" },
        { name: "Google Chrome", version: "131.0", publisher: "Google LLC" },
        { name: "7-Zip", version: "24.08", installed_on: "20260105" },
      ],
    })
    const d = await q1<{ agent_version: string; logged_on_user: string; ram_mb: number; disk_total_gb: number; disk_free_gb: number; os_build: string; last_inventory_at: Date | null; ci_id: string | null }>(
      "select agent_version, logged_on_user, ram_mb, disk_total_gb, disk_free_gb, os_build, last_inventory_at, ci_id from devices where id = $1",
      [device.id]
    )
    expect(d).toMatchObject({ agent_version: "1.0.1", logged_on_user: "CORP\\asha", ram_mb: 16384, disk_total_gb: 500, disk_free_gb: 150, os_build: "26100.2314" })
    expect(d!.last_inventory_at).not.toBeNull()
    const sw = await q<{ name: string }>("select name from device_software where device_id = $1 order by name", [device.id])
    expect(sw.map((s) => s.name)).toEqual(["7-Zip", "Google Chrome"])
    // a later inventory replaces the list
    await agent.ingestInventory(device, { software: [{ name: "Notepad++", version: "8.7" }] })
    expect((await q("select 1 from device_software where device_id = $1", [device.id])).length).toBe(1)
  })

  it("ingests a patch scan, auto-approves by policy and reports the missing count", async () => {
    const policy = await service.createPolicy(admin, {
      name: "Pilot definitions",
      deviceGroupId: pilotId,
      autoApproveClassifications: ["definition"],
      autoApproveDelayDays: 0,
      scheduleDays: [],
      scheduleTime: "02:00",
      maintenanceWindowId: null,
      rebootBehavior: "if_required",
      isActive: true,
    })
    expect(policy).toBeTruthy()
    const r = await agent.ingestPatchScan(device, {
      source: "windows_update",
      scanned_at: new Date().toISOString(),
      available: [
        { external_id: SEC, kb: "5046617", title: "2026-11 Cumulative Update", classification: "Security Updates", severity: "Critical", reboot_required: true, release_date: "2026-11-11" },
        { external_id: UPD, title: "Feature experience pack", classification: "update", severity: "moderate" },
        { external_id: DEF, title: "Defender definitions", classification: "definition" },
        { external_id: SEC, title: "duplicate entry is ignored" },
      ],
      installed: [{ external_id: OLD, kb: "KB5044284", title: "2026-10 CU", installed_on: "2026-10-10" }],
    })
    expect(r).toEqual({ ok: true, missing: 3 })
    const sec = await q1<{ kb: string; classification: string; severity: string; approval: string; os_family: string }>("select kb, classification, severity, approval, os_family from patches where id = $1", [await patchId(SEC)])
    expect(sec).toMatchObject({ kb: "KB5046617", classification: "security", severity: "critical", approval: "pending", os_family: "windows" })
    expect((await q1<{ approval: string }>("select approval from patches where id = $1", [await patchId(DEF)]))!.approval).toBe("approved")
    expect((await stateOf(device.id, await patchId(OLD)))!.state).toBe("installed")
    expect((await q1<{ last_scan_at: Date | null }>("select last_scan_at from devices where id = $1", [device.id]))!.last_scan_at).not.toBeNull()
    const list = await queries.listDevices(admin, { missing: "critical" })
    expect(list.rows.find((x) => x.id === device.id)?.missing_critical).toBe(1)
  })

  it("approves, deploys, dispatches, and applies the install result", async () => {
    await expect(service.setPatchApproval(engineer, [await patchId(SEC)], "approved")).rejects.toThrow(/permission/)
    expect(await service.setPatchApproval(admin, [await patchId(SEC)], "approved")).toBe(1)

    await expect(
      deployments.createDeployment(admin, { name: "Nov patches", patchIds: [await patchId(UPD)], targetGroupIds: [pilotId], targetDeviceIds: [], schedule: "now", rebootBehavior: "if_required" })
    ).rejects.toThrow(/approved/)
    await expect(
      deployments.createDeployment(admin, { name: "Nov patches", patchIds: [await patchId(SEC)], targetGroupIds: [pilotId], targetDeviceIds: [], schedule: "now", rebootBehavior: "if_required", changeNumber: "CHG9999999" })
    ).rejects.toThrow(/no change/i)

    const dep = await deployments.createDeployment(admin, {
      name: "Nov patches",
      patchIds: [await patchId(SEC), await patchId(DEF)],
      targetGroupIds: [pilotId],
      targetDeviceIds: [],
      schedule: "now",
      rebootBehavior: "if_required",
    })
    expect(dep).toMatchObject({ status: "running", jobs: 1 })

    expect((await agent.recordHeartbeat(device, {}, null)).jobs_pending).toBe(1)
    const claimed = await agent.pollJobs(device, 0)
    expect(claimed).toHaveLength(1)
    expect(claimed[0].kind).toBe("install_patches")
    const payload = claimed[0].payload as { patches: { patch_id: string; external_id: string; kb: string | null }[]; reboot: string }
    expect(payload.reboot).toBe("if_required")
    expect(payload.patches.map((p) => p.external_id).sort()).toEqual([DEF, SEC].sort())
    expect(await agent.pollJobs(device, 0)).toEqual([]) // dispatched jobs are not handed out twice

    await agent.updateJobFromAgent(device, claimed[0].id, { status: "running" })
    expect((await q1<{ status: string }>("select status from agent_jobs where id = $1", [claimed[0].id]))!.status).toBe("running")
    await agent.updateJobFromAgent(device, claimed[0].id, {
      status: "succeeded",
      exit_code: 0,
      output: "x".repeat(70_000),
      result: { results: [{ external_id: SEC, status: "installed", error: null }, { external_id: DEF, status: "failed", error: "0x80240022" }], reboot_required: true },
    })
    const job = await q1<{ status: string; output: string; finished_at: Date | null }>("select status, output, finished_at from agent_jobs where id = $1", [claimed[0].id])
    expect(job!.status).toBe("succeeded")
    expect(job!.output.length).toBe(64 * 1024)
    expect((await stateOf(device.id, await patchId(SEC)))!.state).toBe("installed")
    expect(await stateOf(device.id, await patchId(DEF))).toEqual({ state: "failed", last_error: "0x80240022" })
    expect((await q1<{ reboot_pending: boolean }>("select reboot_pending from devices where id = $1", [device.id]))!.reboot_pending).toBe(true)
    expect((await q1<{ status: string; completed_at: Date | null }>("select status, completed_at from patch_deployments where id = $1", [dep.id]))!.status).toBe("completed")

    // a rescan: the failed one is still offered (keeps its error), the update disappeared (installed elsewhere)
    const r = await agent.ingestPatchScan(device, { source: "windows_update", available: [{ external_id: DEF, title: "Defender definitions", classification: "definition" }] })
    expect(r.missing).toBe(1)
    expect((await stateOf(device.id, await patchId(DEF)))!.state).toBe("failed")
    expect((await stateOf(device.id, await patchId(UPD)))!.state).toBe("installed")
    expect((await stateOf(device.id, await patchId(SEC)))!.state).toBe("installed")
  })

  it("runs scripts with an audit trail, cancels jobs, and answers 409 to the agent", async () => {
    await expect(service.runScript(engineer, device.id, { shell: "powershell", script: "whoami", timeoutSeconds: 60 })).rejects.toThrow(/permission/)
    await expect(service.runScript(admin, device.id, { shell: "bash", script: "whoami", timeoutSeconds: 60 })).rejects.toThrow(/not available/)
    const jobId = await service.runScript(admin, device.id, { shell: "powershell", script: "Get-Service\nwhoami", timeoutSeconds: 60 })
    const a = await q1<{ data: { sha256: string; preview: string } }>("select data from audit_log where tenant_id = $1 and action = 'endpoint.script_run' order by id desc limit 1", [tenantId])
    expect(a!.data.preview).toBe("Get-Service\nwhoami")
    expect(a!.data.sha256).toMatch(/^[0-9a-f]{64}$/)
    const [j] = await agent.claimJobs(device)
    expect(j).toMatchObject({ id: jobId, kind: "run_script", payload: { shell: "powershell", script: "Get-Service\nwhoami", timeout_seconds: 60 } })
    await service.cancelAgentJob(admin, jobId)
    await expect(agent.updateJobFromAgent(device, jobId, { status: "running" })).rejects.toMatchObject({ status: 409 })
    await expect(agent.updateJobFromAgent(device, jobId, { status: "nope" })).rejects.toMatchObject({ status: 400 })
  })

  it("keeps devices inside their own tenant", async () => {
    const other = await user(otherTenantId, "admin3", "admin")
    const t = await service.createEnrollmentToken(other, { name: "Other" })
    await exec("update devices set status = 'retired' where tenant_id = $1", [otherTenantId])
    const e = await agent.enrollDevice({ token: t.token, hostname: "OTHER-PC", os_family: "windows" }, ip)
    const foreign = await agent.authenticateDevice(bearer(e.device_id, e.device_secret), null)
    expect(foreign.tenantId).toBe(otherTenantId)
    const myJob = await service.requestDeviceJob(admin, device.id, "scan")
    await expect(agent.updateJobFromAgent(foreign, myJob, { status: "running" })).rejects.toMatchObject({ status: 404 })
    expect(await agent.claimJobs(foreign)).toEqual([])
    await expect(agent.packageForDevice(foreign, await patchId(SEC))).rejects.toMatchObject({ status: 404 })
    await expect(queries.getDevice(other, device.id)).rejects.toMatchObject({ status: 404 })
    await expect(service.setPatchApproval(other, [await patchId(SEC)], "declined")).resolves.toBe(0)
    // the same external id reported in another tenant is a separate catalog entry
    await agent.ingestPatchScan(foreign, { source: "windows_update", available: [{ external_id: SEC, title: "same id" }] })
    expect(await patchId(SEC, otherTenantId)).not.toBe(await patchId(SEC))
    await service.cancelAgentJob(admin, myJob)
  })

  it("starts scheduled deployments, runs policy schedules and expires stuck jobs", async () => {
    await service.setPatchApproval(admin, [await patchId(UPD)], "approved")
    await exec("update device_patches set state = 'missing' where device_id = $1 and patch_id = $2", [device.id, await patchId(UPD)])

    // scheduled for later → job picks it up once due
    const later = new Date(Date.now() + 3600_000)
    const dep = await deployments.createDeployment(admin, { name: "Later", patchIds: [await patchId(UPD)], targetGroupIds: [], targetDeviceIds: [device.id], schedule: "at", scheduledAt: later, rebootBehavior: "never" })
    expect(dep.status).toBe("scheduled")
    await deployments.runDeploymentsStart()
    expect((await q1<{ status: string }>("select status from patch_deployments where id = $1", [dep.id]))!.status).toBe("scheduled")
    await exec("update patch_deployments set scheduled_at = now() - interval '1 minute' where id = $1", [dep.id])
    await deployments.runDeploymentsStart()
    expect((await q1<{ status: string }>("select status from patch_deployments where id = $1", [dep.id]))!.status).toBe("running")
    const jobRows = await q<{ id: string; payload: { reboot: string; patches: { external_id: string }[] } }>("select id, payload from agent_jobs where deployment_id = $1", [dep.id])
    expect(jobRows).toHaveLength(1)
    expect(jobRows[0].payload.reboot).toBe("never")
    expect(jobRows[0].payload.patches.map((p) => p.external_id)).toEqual([UPD])

    // a dispatched job silent for over 3 h expires and completes its deployment
    await exec("update agent_jobs set status = 'dispatched', dispatched_at = now() - interval '4 hours' where id = $1", [jobRows[0].id])
    expect(await jobs.expireAgentJobs()).toBeGreaterThanOrEqual(1)
    expect((await q1<{ status: string }>("select status from agent_jobs where id = $1", [jobRows[0].id]))!.status).toBe("expired")
    expect((await q1<{ status: string }>("select status from patch_deployments where id = $1", [dep.id]))!.status).toBe("completed")

    // a policy scheduled every day a few minutes ago creates one deployment for this slot
    const now = new Date()
    const slot = new Date(now.getTime() - 5 * 60_000)
    const hhmm = `${String(slot.getUTCHours()).padStart(2, "0")}:${String(slot.getUTCMinutes()).padStart(2, "0")}`
    const pol = await service.createPolicy(admin, {
      name: "Pilot nightly",
      deviceGroupId: pilotId,
      autoApproveClassifications: [],
      autoApproveDelayDays: 0,
      scheduleDays: [0, 1, 2, 3, 4, 5, 6],
      scheduleTime: hhmm,
      maintenanceWindowId: null,
      rebootBehavior: "always",
      isActive: true,
    })
    await exec("update patch_policies set created_at = now() - interval '1 day' where id = $1", [pol])
    await jobs.runPatchPolicies(now)
    await jobs.runPatchPolicies(now) // same slot: no second deployment
    const made = await q<{ id: string; status: string; reboot_behavior: string }>("select id, status, reboot_behavior from patch_deployments where policy_id = $1", [pol])
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ status: "running", reboot_behavior: "always" })
    expect((await q1<{ last_run_at: Date | null }>("select last_run_at from patch_policies where id = $1", [pol]))!.last_run_at).not.toBeNull()
    await deployments.cancelDeployment(admin, made[0].id)
    expect((await q1<{ n: number }>("select count(*) as n from agent_jobs where deployment_id = $1 and status = 'cancelled'", [made[0].id]))!.n).toBe(1)
  })

  it("reports compliance and retires devices", async () => {
    const s = await queries.complianceSummary(tenantId)
    expect(s.total).toBe(1)
    // DEF (failed) is a definition update, UPD is an update: neither is security/critical → compliant
    expect(s.compliant).toBe(1)
    expect(s.topMissing.length).toBeGreaterThan(0)
    await service.retireDevice(admin, device.id)
    await expect(agent.authenticateDevice(bearer(device.id, secret), null)).rejects.toMatchObject({ status: 401 })
    expect((await queries.complianceSummary(tenantId)).total).toBe(0)
  })
})
