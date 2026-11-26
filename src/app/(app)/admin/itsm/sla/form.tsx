/** SLA / OLA policy form fields (server component). */
import { Field } from "@/components/ui"
import { PRIORITIES, PRIORITY_LABELS, TICKET_TYPES, TICKET_TYPE_LABELS } from "@/lib/itsm/vocab"
import { splitMinutes } from "@/lib/admin/rules"
import type { AdminSlaPolicy } from "@/lib/admin/sla"

export function SlaFields({ kind, policy, groups }: { kind: "sla" | "ola"; policy?: AdminSlaPolicy; groups: { id: string; name: string; is_active: boolean }[] }) {
  const resp = splitMinutes(policy?.response_minutes ?? 60)
  const reso = splitMinutes(policy?.resolution_minutes ?? 480)
  const pre = policy ? policy.id.slice(0, 8) : kind
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="kind" value={kind} />
      {kind === "ola" && (
        <Field label="Support group" htmlFor={`${pre}-group`} required className="sm:col-span-2 lg:col-span-4">
          <select id={`${pre}-group`} name="groupId" className="input" required defaultValue={policy?.group_id ?? ""}>
            <option value="" disabled>
              Choose a group…
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.is_active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Record type" htmlFor={`${pre}-type`} hint="“All types” applies when a type has no policy of its own">
        <select id={`${pre}-type`} name="ticketType" className="input" defaultValue={policy?.ticket_type ?? ""}>
          <option value="">All types</option>
          {TICKET_TYPES.map((t) => (
            <option key={t} value={t}>
              {TICKET_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Priority" htmlFor={`${pre}-priority`} required>
        <select id={`${pre}-priority`} name="priority" className="input" defaultValue={policy?.priority ?? "medium"}>
          {[...PRIORITIES].reverse().map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={kind === "ola" ? "Respond within" : "First response within"} htmlFor={`${pre}-rh`} required>
        <div className="flex items-center gap-1">
          <input id={`${pre}-rh`} name="responseHours" type="number" min={0} max={8760} className="input" defaultValue={resp.hours} aria-label="Response hours" />
          <span className="text-xs text-slate-500">h</span>
          <input name="responseMinutes" type="number" min={0} max={59} className="input" defaultValue={resp.minutes} aria-label="Response minutes" />
          <span className="text-xs text-slate-500">min</span>
        </div>
      </Field>
      <Field label="Resolve within" htmlFor={`${pre}-sh`} required>
        <div className="flex items-center gap-1">
          <input id={`${pre}-sh`} name="resolutionHours" type="number" min={0} max={8760} className="input" defaultValue={reso.hours} aria-label="Resolution hours" />
          <span className="text-xs text-slate-500">h</span>
          <input name="resolutionMinutes" type="number" min={0} max={59} className="input" defaultValue={reso.minutes} aria-label="Resolution minutes" />
          <span className="text-xs text-slate-500">min</span>
        </div>
      </Field>
      <Field label="Warn at" htmlFor={`${pre}-warn`} hint="Per cent of the target used up">
        <div className="flex items-center gap-1">
          <input id={`${pre}-warn`} name="warnPercent" type="number" min={10} max={99} className="input" defaultValue={policy?.warn_percent ?? 75} />
          <span className="text-xs text-slate-500">%</span>
        </div>
      </Field>
      <div className="flex flex-col justify-end gap-1.5 sm:col-span-1 lg:col-span-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="businessHours" defaultChecked={policy?.business_hours ?? false} /> Count business hours only (working calendar)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={policy?.is_active ?? true} /> Active
        </label>
      </div>
    </div>
  )
}
