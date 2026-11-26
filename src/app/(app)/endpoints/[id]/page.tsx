import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission, can } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { deviceJobs, devicePatches, deviceSoftware, getDevice, listDeviceGroups, type DevicePatchRow } from "@/lib/endpoints/queries"
import { JobList } from "../components"
import {
  ONLINE_MINUTES,
  OS_LABELS,
  REBOOT_BEHAVIORS,
  REBOOT_LABELS,
  formatUptime,
  patchStateTone,
  severityTone,
  shellsFor,
  approvalTone,
  type OsFamily,
} from "@/lib/endpoints/vocab"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, KeyValues, PageHeader, Tabs, When, qs } from "@/components/ui"
import { formatDate, formatDateTime } from "@/lib/format"
import { humanize } from "@/lib/itsm/vocab"
import {
  deviceJobAction,
  deviceSettingsAction,
  installNowAction,
  rebootAction,
  retireAction,
  runScriptAction,
} from "../actions"

type SP = Record<string, string | undefined>

export const metadata = { title: "Device" }

function PatchTable({ rows, tz }: { rows: DevicePatchRow[]; tz: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">None.</p>
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Patch</th>
            <th>Severity</th>
            <th>Approval</th>
            <th>State</th>
            <th>Detected / installed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.patch_id}>
              <td className="max-w-xl">
                <Link href={`/patches/${p.patch_id}`}>{p.title}</Link>
                <div className="text-xs text-slate-500">{[p.kb, humanize(p.classification), p.release_date ? `released ${formatDate(p.release_date)}` : null].filter(Boolean).join(" · ")}</div>
                {p.last_error && <div className="mt-1 text-xs text-red-700">{p.last_error}</div>}
              </td>
              <td><Badge tone={severityTone(p.severity)}>{p.severity}</Badge></td>
              <td><Badge tone={approvalTone(p.approval)}>{p.approval}</Badge></td>
              <td><Badge tone={patchStateTone(p.state)}>{humanize(p.state)}</Badge></td>
              <td className="text-xs whitespace-nowrap text-slate-500">
                {p.installed_at ? <>Installed <When value={p.installed_at} timeZone={tz} /></> : <>Detected <When value={p.detected_at} timeZone={tz} /></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function DevicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const actor = await requirePermission("endpoint.view")
  const { id } = await params
  const sp = await searchParams
  let d
  try {
    d = await getDevice(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const tz = actor.tenant.timezone
  const manage = can(actor, "endpoint.manage")
  const canScript = can(actor, "endpoint.run_script")
  const active = d.status === "active"
  const tab = ["software", "patches", "jobs", "script"].includes(sp.tab ?? "") ? sp.tab! : "overview"
  const online = d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_MINUTES * 60_000

  const [patches, jobs, software, groups] = await Promise.all([
    devicePatches(actor, d.id),
    tab === "jobs" || tab === "overview" ? deviceJobs(actor, d.id, tab === "jobs" ? 200 : 5) : Promise.resolve([]),
    tab === "software" ? deviceSoftware(actor, d.id, sp.sq) : Promise.resolve({ rows: [], total: 0 }),
    manage ? listDeviceGroups(actor.tenantId) : Promise.resolve([]),
  ])
  const missing = patches.filter((p) => p.state === "missing" || p.state === "failed")
  const missingCritical = missing.filter((p) => p.severity === "critical").length
  const approvedMissing = missing.filter((p) => p.approval === "approved").length
  const inv = (d.inventory ?? {}) as { hardware?: { disks?: { name?: string | null; size_gb?: number | null; free_gb?: number | null }[] }; os?: { install_date?: string | null } }
  const disks = Array.isArray(inv.hardware?.disks) ? inv.hardware!.disks! : []
  const base = `/endpoints/${d.id}`

  return (
    <>
      <PageHeader
        back={{ href: "/endpoints", label: "Devices" }}
        title={d.hostname}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={online ? "green" : "gray"}>{online ? "Online" : "Offline"}</Badge>
            {!active && <Badge tone="red">Retired</Badge>}
            {d.group_name && <Badge tone="blue">{d.group_name}</Badge>}
            {d.reboot_pending && <Badge tone="purple">Reboot pending</Badge>}
            {missingCritical > 0 && <Badge tone="red">{missingCritical} critical missing</Badge>}
            {d.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
            <span className="text-xs">
              Last seen <When value={d.last_seen_at} timeZone={tz} />
            </span>
          </span>
        }
      />

      <Tabs
        items={[
          { href: base, label: "Overview", active: tab === "overview" },
          { href: `${base}?tab=software`, label: "Software", active: tab === "software" },
          { href: `${base}?tab=patches`, label: `Patches${missing.length ? ` (${missing.length} missing)` : ""}`, active: tab === "patches" },
          { href: `${base}?tab=jobs`, label: "Jobs", active: tab === "jobs" },
          ...(canScript && active ? [{ href: `${base}?tab=script`, label: "Run script", active: tab === "script" }] : []),
        ]}
      />

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="min-w-0 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Hardware">
                <KeyValues
                  items={[
                    ["Manufacturer", d.manufacturer],
                    ["Model", d.model],
                    ["Serial number", d.serial_no],
                    ["CPU", d.cpu ? `${d.cpu}${d.cpu_cores ? ` (${d.cpu_cores} cores)` : ""}` : null],
                    ["Memory", d.ram_mb ? `${(d.ram_mb / 1024).toFixed(1)} GB` : null],
                    ["Disk", d.disk_total_gb !== null ? `${d.disk_free_gb ?? "?"} GB free of ${d.disk_total_gb} GB` : null],
                    ...(disks.length > 1
                      ? ([["Volumes", disks.map((x) => `${x.name ?? "?"} ${x.free_gb ?? "?"}/${x.size_gb ?? "?"} GB`).join(", ")]] as [string, string][])
                      : []),
                  ]}
                />
              </Card>
              <Card title="Operating system">
                <KeyValues
                  items={[
                    ["OS", d.os_name ?? OS_LABELS[d.os_family as OsFamily]],
                    ["Version", [d.os_version, d.os_build ? `build ${d.os_build}` : null].filter(Boolean).join(" · ") || null],
                    ["Architecture", d.arch],
                    ["Domain", d.domain],
                    ["Installed", inv.os?.install_date ? formatDate(inv.os.install_date) : null],
                    ["Logged on", d.logged_on_user],
                    ["Uptime", d.uptime_seconds !== null ? formatUptime(d.uptime_seconds) : null],
                  ]}
                />
              </Card>
              <Card title="Network">
                <KeyValues
                  items={[
                    ["IP addresses", d.ip_addresses.length ? d.ip_addresses.join(", ") : null],
                    ["MAC addresses", d.mac_addresses.length ? <span key="m" className="font-mono text-xs">{d.mac_addresses.join(", ")}</span> : null],
                    ["Last connected from", d.last_ip],
                  ]}
                />
              </Card>
              <Card title="Agent">
                <KeyValues
                  items={[
                    ["Agent version", d.agent_version],
                    ["Enrolled", formatDateTime(d.enrolled_at, tz)],
                    ["Last seen", d.last_seen_at ? formatDateTime(d.last_seen_at, tz) : null],
                    ["Last inventory", d.last_inventory_at ? formatDateTime(d.last_inventory_at, tz) : "Never"],
                    ["Last patch scan", d.last_scan_at ? formatDateTime(d.last_scan_at, tz) : "Never"],
                    [
                      "CMDB item",
                      d.ci_id ? (
                        can(actor, "cmdb.view") ? (
                          <Link key="ci" href={`/cmdb/${d.ci_id}`}>{d.ci_code ?? "Open"}{d.ci_name && d.ci_name !== d.ci_code ? ` · ${d.ci_name}` : ""}</Link>
                        ) : (
                          d.ci_code ?? "Linked"
                        )
                      ) : (
                        "Not linked yet (after the first inventory)"
                      ),
                    ],
                  ]}
                />
              </Card>
            </div>
            <Card title="Patch status" actions={<Link href={`${base}?tab=patches`} className="text-xs">All patches</Link>}>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><div className="text-2xl font-semibold">{missing.length}</div><div className="text-xs text-slate-500">missing</div></div>
                <div><div className={`text-2xl font-semibold ${missingCritical ? "text-red-600" : ""}`}>{missingCritical}</div><div className="text-xs text-slate-500">critical missing</div></div>
                <div><div className="text-2xl font-semibold">{approvedMissing}</div><div className="text-xs text-slate-500">approved, not installed</div></div>
                <div><div className="text-2xl font-semibold">{patches.filter((p) => p.state === "installed").length}</div><div className="text-xs text-slate-500">installed</div></div>
              </div>
            </Card>
            <Card title="Recent jobs" actions={<Link href={`${base}?tab=jobs`} className="text-xs">All jobs</Link>}>
              <JobList jobs={jobs} tz={tz} deviceId={d.id} canCancel={manage} />
            </Card>
          </div>

          <aside className="space-y-4">
            {manage && active && (
              <Card title="Actions">
                <div className="space-y-2">
                  <ActionForm action={deviceJobAction.bind(null, d.id, "inventory")}>
                    <SubmitButton className="btn w-full">Run inventory</SubmitButton>
                  </ActionForm>
                  <ActionForm action={deviceJobAction.bind(null, d.id, "scan")}>
                    <SubmitButton className="btn w-full">Scan for patches now</SubmitButton>
                  </ActionForm>
                  <details className="rounded-md border border-slate-200">
                    <summary className="btn w-full list-none">Install approved missing patches…</summary>
                    <ActionForm action={installNowAction.bind(null, d.id)} className="space-y-2 p-3" confirm={`Install ${approvedMissing} approved patch(es) on ${d.hostname} now?`}>
                      <p className="hint mt-0">{approvedMissing} approved patch{approvedMissing === 1 ? " is" : "es are"} missing on this device.</p>
                      <select name="reboot" className="input" defaultValue="if_required" aria-label="Reboot behaviour">
                        {REBOOT_BEHAVIORS.map((r) => (
                          <option key={r} value={r}>{REBOOT_LABELS[r]}</option>
                        ))}
                      </select>
                      <SubmitButton className="btn btn-primary w-full">Install now</SubmitButton>
                    </ActionForm>
                  </details>
                  <details className="rounded-md border border-slate-200">
                    <summary className="btn w-full list-none">Reboot…</summary>
                    <ActionForm action={rebootAction.bind(null, d.id)} className="space-y-2 p-3" confirm={`Reboot ${d.hostname}?`}>
                      <select name="delaySeconds" className="input" defaultValue="300" aria-label="Delay">
                        <option value="0">Immediately</option>
                        <option value="60">In 1 minute</option>
                        <option value="300">In 5 minutes</option>
                        <option value="900">In 15 minutes</option>
                        <option value="3600">In 1 hour</option>
                      </select>
                      <input name="message" className="input" maxLength={500} placeholder="Message for the logged-on user (optional)" />
                      <SubmitButton className="btn btn-danger w-full">Reboot</SubmitButton>
                    </ActionForm>
                  </details>
                </div>
              </Card>
            )}
            {manage && (
              <Card title="Group and tags">
                <ActionForm action={deviceSettingsAction.bind(null, d.id)} className="space-y-2">
                  <select name="groupId" defaultValue={d.group_id ?? ""} className="input" aria-label="Device group">
                    <option value="">— No group —</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name} (ring {g.ring})</option>
                    ))}
                  </select>
                  <input name="tags" className="input" defaultValue={d.tags.join(", ")} placeholder="Tags, comma separated" />
                  <SubmitButton className="btn w-full">Save</SubmitButton>
                </ActionForm>
              </Card>
            )}
            {manage && active && (
              <Card title="Retire">
                <p className="mb-2 text-sm text-slate-600">The agent can no longer connect and open jobs are cancelled. The device stops counting against the licence.</p>
                <ActionForm action={retireAction.bind(null, d.id)} confirm={`Retire ${d.hostname}? Its agent will be refused from now on; to manage it again it must be re-enrolled.`}>
                  <SubmitButton className="btn btn-danger w-full">Retire device</SubmitButton>
                </ActionForm>
              </Card>
            )}
          </aside>
        </div>
      )}

      {tab === "software" && (
        <Card
          title={`Installed software (${software.total})`}
          actions={
            <form method="get" className="flex gap-2">
              <input type="hidden" name="tab" value="software" />
              <input name="sq" defaultValue={sp.sq} className="input py-1" placeholder="Filter by name or publisher" aria-label="Filter software" />
              <button className="btn btn-sm">Filter</button>
            </form>
          }
          bodyClassName="p-0"
        >
          {software.rows.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">{d.last_inventory_at ? "No software matches." : "No inventory has been received from this device yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Version</th>
                    <th>Publisher</th>
                    <th>Installed</th>
                  </tr>
                </thead>
                <tbody>
                  {software.rows.map((s) => (
                    <tr key={`${s.name}\u0001${s.version}`}>
                      <td>{s.name}</td>
                      <td className="font-mono text-xs">{s.version || "—"}</td>
                      <td className="text-slate-600">{s.publisher ?? "—"}</td>
                      <td className="text-xs whitespace-nowrap text-slate-500">{s.installed_on ? formatDate(s.installed_on) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {software.total > software.rows.length && <p className="p-3 text-xs text-slate-500">Showing the first {software.rows.length} of {software.total}. Filter to narrow down.</p>}
            </div>
          )}
        </Card>
      )}

      {tab === "patches" && (
        <div className="space-y-4">
          {!d.last_scan_at && <EmptyState title="No patch scan yet">The agent scans for patches after enrolment and then daily.</EmptyState>}
          <Card title={`Missing (${patches.filter((p) => p.state === "missing").length})`}>
            <PatchTable rows={patches.filter((p) => p.state === "missing")} tz={tz} />
          </Card>
          <Card title={`Failed (${patches.filter((p) => p.state === "failed").length})`}>
            <PatchTable rows={patches.filter((p) => p.state === "failed")} tz={tz} />
          </Card>
          {patches.some((p) => p.state === "pending_reboot") && (
            <Card title={`Installed, waiting for a reboot (${patches.filter((p) => p.state === "pending_reboot").length})`}>
              <PatchTable rows={patches.filter((p) => p.state === "pending_reboot")} tz={tz} />
            </Card>
          )}
          <Card title={`Installed (${patches.filter((p) => p.state === "installed").length})`}>
            <PatchTable rows={patches.filter((p) => p.state === "installed")} tz={tz} />
          </Card>
        </div>
      )}

      {tab === "jobs" && (
        <Card title="Job history" actions={<Link href={`${base}${qs({ tab: "jobs" })}`} className="text-xs">Refresh</Link>}>
          <JobList jobs={jobs} tz={tz} deviceId={d.id} canCancel={manage} />
        </Card>
      )}

      {tab === "script" && canScript && active && (
        <Card title="Run a script">
          <p className="mb-3 text-sm text-slate-600">
            The script runs as <strong>{d.os_family === "windows" ? "SYSTEM" : "root"}</strong> on {d.hostname} the next time the agent polls. Every script is recorded in
            the audit log with its SHA-256 hash and first 200 characters. Output (up to 64 KB) appears in the job history.
          </p>
          <ActionForm action={runScriptAction.bind(null, d.id)} className="space-y-3" confirm={`Run this script as ${d.os_family === "windows" ? "SYSTEM" : "root"} on ${d.hostname}?`}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="shell">Shell</label>
                <select id="shell" name="shell" className="input" defaultValue={shellsFor(d.os_family)[0]}>
                  {shellsFor(d.os_family).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="timeoutSeconds">Timeout (seconds)</label>
                <input id="timeoutSeconds" name="timeoutSeconds" type="number" min={10} max={3600} defaultValue={300} className="input" />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="script">Script</label>
              <textarea id="script" name="script" rows={12} required maxLength={100_000} className="input font-mono text-xs" spellCheck={false} placeholder={d.os_family === "windows" ? "Get-Service | Where-Object Status -eq 'Stopped'" : "df -h"} />
            </div>
            <SubmitButton className="btn btn-danger">Run script</SubmitButton>
          </ActionForm>
        </Card>
      )}
    </>
  )
}
