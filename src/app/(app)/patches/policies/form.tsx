/** Fields of a patch policy (create and edit). Server-rendered. */
import type { PolicyRow } from "@/lib/endpoints/queries"
import { CLASSIFICATIONS, REBOOT_BEHAVIORS, REBOOT_LABELS, WEEKDAY_LABELS } from "@/lib/endpoints/vocab"
import { humanize } from "@/lib/itsm/vocab"

export function PolicyFields({
  policy,
  groups,
  windows,
  canApprove,
  tz,
}: {
  policy?: PolicyRow
  groups: { id: string; name: string; ring: number }[]
  windows: { id: string; name: string }[]
  canApprove: boolean
  tz: string
}) {
  const classes = new Set(policy?.auto_approve_classifications ?? [])
  const days = new Set(policy?.schedule_days ?? [])
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="pname">Name</label>
          <input id="pname" name="name" required minLength={2} maxLength={200} defaultValue={policy?.name} className="input" placeholder="e.g. Pilot: security updates weekly" />
        </div>
        <div>
          <label className="label" htmlFor="pgroup">Applies to</label>
          <select id="pgroup" name="deviceGroupId" defaultValue={policy?.device_group_id ?? ""} className="input">
            <option value="">Every device</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name} (ring {g.ring})</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="pdesc">Description</label>
        <input id="pdesc" name="description" maxLength={2000} defaultValue={policy?.description ?? ""} className="input" />
      </div>

      <fieldset className="rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-medium text-slate-700">Auto-approval</legend>
        {!canApprove && <p className="hint mt-0 mb-2">Auto-approval needs the permission to approve patches.</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {CLASSIFICATIONS.map((c) => (
            <label key={c} className="flex items-center gap-1.5">
              <input type="checkbox" name="autoApproveClassifications" value={c} defaultChecked={classes.has(c)} disabled={!canApprove} /> {humanize(c)}
            </label>
          ))}
        </div>
        {!canApprove && [...classes].map((c) => <input key={c} type="hidden" name="autoApproveClassifications" value={c} />)}
        <div className="mt-2 flex items-center gap-2 text-sm">
          <span>after</span>
          <input name="autoApproveDelayDays" type="number" min={0} max={365} defaultValue={policy?.auto_approve_delay_days ?? 0} className="input w-20" aria-label="Delay in days" />
          <span>days since first seen</span>
        </div>
        <p className="hint">Pending patches of these classifications that a covered device is missing are approved automatically.</p>
      </fieldset>

      <fieldset className="rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-medium text-slate-700">Automatic deployment</legend>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {WEEKDAY_LABELS.map((d, i) => (
            <label key={d} className="flex items-center gap-1.5">
              <input type="checkbox" name="scheduleDays" value={i} defaultChecked={days.has(i)} /> {d}
            </label>
          ))}
        </div>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="ptime">At ({tz})</label>
            <input id="ptime" name="scheduleTime" type="time" required defaultValue={policy?.schedule_time ?? "02:00"} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="pwindow">Then wait for</label>
            <select id="pwindow" name="maintenanceWindowId" defaultValue={policy?.maintenance_window_id ?? ""} className="input">
              <option value="">No window (install at once)</option>
              {windows.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="preboot">Reboot</label>
            <select id="preboot" name="rebootBehavior" defaultValue={policy?.reboot_behavior ?? "if_required"} className="input">
              {REBOOT_BEHAVIORS.map((r) => (
                <option key={r} value={r}>{REBOOT_LABELS[r]}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="hint">On the chosen days and time, a deployment of every approved patch the group is missing is created. No days = no automatic deployment.</p>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" defaultChecked={policy ? policy.is_active : true} /> Active
      </label>
    </div>
  )
}
