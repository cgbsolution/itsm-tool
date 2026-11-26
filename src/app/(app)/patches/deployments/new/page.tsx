import { requirePermission } from "@/lib/auth/session"
import { approvedPatchOptions, deviceOptions, listDeviceGroups, patchMaintenanceWindows } from "@/lib/endpoints/queries"
import { OS_FAMILIES, OS_LABELS, REBOOT_BEHAVIORS, REBOOT_LABELS, severityTone, type OsFamily } from "@/lib/endpoints/vocab"
import { humanize } from "@/lib/itsm/vocab"
import { formatDate, formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, PageHeader } from "@/components/ui"
import { CheckAll } from "../../../endpoints/client"
import { createDeploymentAction } from "../../actions"

export const metadata = { title: "New deployment" }

type SP = Record<string, string | undefined>

export default async function NewDeploymentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("patch.deploy")
  const sp = await searchParams
  const tz = actor.tenant.timezone
  const [patches, groups, devices, windows] = await Promise.all([
    approvedPatchOptions(actor, { q: sp.q, os: sp.os, all: sp.all === "1" }),
    listDeviceGroups(actor.tenantId),
    deviceOptions(actor.tenantId),
    patchMaintenanceWindows(actor.tenantId),
  ])
  const preselect = new Set((sp.patch ?? "").split(",").filter(Boolean))
  const today = formatDate(new Date().toISOString().slice(0, 10))

  return (
    <>
      <PageHeader back={{ href: "/patches/deployments", label: "Deployments" }} title="New patch deployment" subtitle="Each target device gets the selected approved patches it is missing." />

      <form method="get" className="card mb-4 grid gap-2 p-3 sm:grid-cols-[1fr_auto_auto_auto]">
        <input name="q" defaultValue={sp.q} placeholder="Filter approved patches by title or KB…" className="input" />
        <select name="os" defaultValue={sp.os ?? ""} className="input" aria-label="Operating system">
          <option value="">Any OS</option>
          {OS_FAMILIES.map((o) => (
            <option key={o} value={o}>{OS_LABELS[o]}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" name="all" value="1" defaultChecked={sp.all === "1"} /> Include patches no device misses
        </label>
        {sp.patch && <input type="hidden" name="patch" value={sp.patch} />}
        <button className="btn">Filter</button>
      </form>

      <ActionForm action={createDeploymentAction} className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <Card title={`Approved patches (${patches.length})`} bodyClassName="p-0">
          {patches.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No approved patches {sp.all === "1" ? "" : "are missing on any device "}match. Approve patches in the catalog first.</p>
          ) : (
            <div className="max-h-[36rem] overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-8"><CheckAll name="patchIds" /></th>
                    <th>Patch</th>
                    <th>Severity</th>
                    <th className="text-right">Missing on</th>
                  </tr>
                </thead>
                <tbody>
                  {patches.map((p) => (
                    <tr key={p.id}>
                      <td><input type="checkbox" name="patchIds" value={p.id} defaultChecked={preselect.has(p.id)} aria-label={`Select ${p.title}`} /></td>
                      <td>
                        <label className="block">{p.title}</label>
                        <span className="text-xs text-slate-500">
                          {[p.kb, OS_LABELS[p.os_family as OsFamily], humanize(p.classification), p.package_file_id ? "offline package" : null].filter(Boolean).join(" · ")}
                        </span>
                      </td>
                      <td><Badge tone={severityTone(p.severity)}>{p.severity}</Badge></td>
                      <td className="text-right text-slate-600">{p.missing}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Deployment">
            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="dname">Name</label>
                <input id="dname" name="name" required minLength={3} maxLength={200} className="input" defaultValue={`Patches ${today}`} />
              </div>
              <div>
                <label className="label" htmlFor="ddesc">Description</label>
                <textarea id="ddesc" name="description" rows={2} maxLength={5000} className="input min-h-0" />
              </div>
              <div>
                <label className="label" htmlFor="dchange">Change number (optional)</label>
                <input id="dchange" name="changeNumber" maxLength={40} className="input font-mono" placeholder="CHG0001234" />
                <p className="hint">The change must be scheduled or implementing.</p>
              </div>
            </div>
          </Card>

          <Card title="Targets">
            <div className="space-y-3">
              <fieldset>
                <legend className="label">Device groups</legend>
                <div className="space-y-1">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="targetGroupIds" value={g.id} />
                      {g.name} <span className="text-xs text-slate-500">ring {g.ring} · {g.devices} device{g.devices === 1 ? "" : "s"}</span>
                    </label>
                  ))}
                  {groups.length === 0 && <p className="text-sm text-slate-500">No groups.</p>}
                </div>
              </fieldset>
              <div>
                <label className="label" htmlFor="ddevices">Individual devices</label>
                <select id="ddevices" name="targetDeviceIds" multiple size={8} className="input">
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>{d.hostname}{d.group_name ? ` (${d.group_name})` : ""}</option>
                  ))}
                </select>
                <p className="hint">Ctrl-click to select several. Groups and devices are combined.</p>
              </div>
            </div>
          </Card>

          <Card title="Schedule">
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="schedule" value="now" defaultChecked /> Start now
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="schedule" value="at" className="mt-2" />
                <span className="flex-1">
                  At a time ({tz})
                  <input type="datetime-local" name="scheduledAt" className="input mt-1" aria-label="Start time" />
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="schedule" value="window" className="mt-2" disabled={windows.length === 0} />
                <span className="flex-1">
                  In the next maintenance window
                  <select name="maintenanceWindowId" className="input mt-1" disabled={windows.length === 0} aria-label="Maintenance window">
                    {windows.length === 0 && <option value="">No maintenance windows for patches</option>}
                    {windows.map((w) => (
                      <option key={w.id} value={w.id}>{w.name} ({w.recurrence === "none" ? formatDateTime(w.starts_at, tz) : `${w.recurrence}, from ${formatDateTime(w.starts_at, tz)}`})</option>
                    ))}
                  </select>
                </span>
              </label>
              <div className="pt-2">
                <label className="label" htmlFor="dreboot">Reboot</label>
                <select id="dreboot" name="rebootBehavior" className="input" defaultValue="if_required">
                  {REBOOT_BEHAVIORS.map((r) => (
                    <option key={r} value={r}>{REBOOT_LABELS[r]}</option>
                  ))}
                </select>
              </div>
            </div>
          </Card>
          <SubmitButton className="btn btn-primary w-full">Create deployment</SubmitButton>
        </div>
      </ActionForm>
    </>
  )
}
