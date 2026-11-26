/** Maintenance window / change freeze form (server component). */
import type { WindowRow } from "@/lib/itsm/windows"
import { toLocalInput } from "@/lib/validate"
import { RECURRENCES, RECURRENCE_LABELS, WINDOW_KINDS, WINDOW_KIND_LABELS, WINDOW_SCOPES, WINDOW_SCOPE_LABELS } from "@/lib/admin/windows"
import { Field } from "@/components/ui"

export function WindowFields({ w, timeZone }: { w?: WindowRow; timeZone: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" htmlFor="name" required>
        <input id="name" name="name" className="input" required maxLength={200} defaultValue={w?.name ?? ""} />
      </Field>
      <Field label="Kind" htmlFor="kind" hint="During a change freeze, changes and patch deployments are blocked">
        <select id="kind" name="kind" className="input" defaultValue={w?.kind ?? "maintenance"}>
          {WINDOW_KINDS.map((k) => (
            <option key={k} value={k}>
              {WINDOW_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description" htmlFor="description" className="sm:col-span-2">
        <textarea id="description" name="description" className="input" rows={2} maxLength={2000} defaultValue={w?.description ?? ""} />
      </Field>
      <Field label="Applies to" htmlFor="appliesTo">
        <select id="appliesTo" name="appliesTo" className="input" defaultValue={w?.applies_to ?? "all"}>
          {WINDOW_SCOPES.map((s) => (
            <option key={s} value={s}>
              {WINDOW_SCOPE_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      <div />
      <Field label="Starts" htmlFor="startsAt" required hint={`Time zone: ${timeZone}`}>
        <input id="startsAt" name="startsAt" type="datetime-local" className="input" required defaultValue={toLocalInput(w?.starts_at, timeZone)} />
      </Field>
      <Field label="Ends" htmlFor="endsAt" required>
        <input id="endsAt" name="endsAt" type="datetime-local" className="input" required defaultValue={toLocalInput(w?.ends_at, timeZone)} />
      </Field>
      <Field label="Repeats" htmlFor="recurrence" hint="A repeating window keeps its length and time of day">
        <select id="recurrence" name="recurrence" className="input" defaultValue={w?.recurrence ?? "none"}>
          {RECURRENCES.map((r) => (
            <option key={r} value={r}>
              {RECURRENCE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Repeat until" htmlFor="recurrenceUntil" hint="Optional. Leave empty to repeat forever.">
        <input id="recurrenceUntil" name="recurrenceUntil" type="datetime-local" className="input" defaultValue={toLocalInput(w?.recurrence_until, timeZone)} />
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="isActive" defaultChecked={w?.is_active ?? true} /> Active
      </label>
    </div>
  )
}
