/** Ticket form fields shared by the new and edit pages (server component). */
import { CategoryPicker, PriorityPicker } from "@/components/client"
import { Field } from "@/components/ui"
import type { ItsmConfig, CustomFieldRow } from "@/lib/itsm/config"
import { CHANGE_TYPES, CHANGE_TYPE_LABELS, RISKS, type TicketType } from "@/lib/itsm/vocab"
import { toLocalInput } from "@/lib/validate"

export function CustomFieldInputs({ fields, values }: { fields: CustomFieldRow[]; values?: Record<string, unknown> }) {
  if (!fields.length) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => {
        const name = `custom.${f.key}`
        const v = values?.[f.key]
        const common = { id: name, name, required: f.required && f.field_type !== "checkbox", className: "input" }
        let control
        switch (f.field_type) {
          case "textarea":
            control = <textarea {...common} defaultValue={(v as string) ?? ""} rows={3} />
            break
          case "number":
            control = <input {...common} type="number" step="any" defaultValue={(v as number) ?? ""} />
            break
          case "date":
            control = <input {...common} type="date" defaultValue={(v as string) ?? ""} />
            break
          case "email":
            control = <input {...common} type="email" defaultValue={(v as string) ?? ""} />
            break
          case "select":
            control = (
              <select {...common} defaultValue={(v as string) ?? ""}>
                <option value="">—</option>
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            )
            break
          case "multiselect":
            control = (
              <select {...common} name={`${name}[]`} multiple defaultValue={(v as string[]) ?? []} className="input h-24">
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            )
            break
          case "checkbox":
            control = (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={name} defaultChecked={!!v} /> {f.help_text ?? "Yes"}
              </label>
            )
            break
          default:
            control = <input {...common} defaultValue={(v as string) ?? ""} />
        }
        return (
          <Field key={f.id} label={f.label} htmlFor={name} hint={f.field_type === "checkbox" ? undefined : f.help_text} required={f.required}>
            {control}
          </Field>
        )
      })}
    </div>
  )
}

export type FieldDefaults = Partial<{
  subject: string
  description: string | null
  category_id: string | null
  impact: string | null
  urgency: string | null
  priority: string | null
  contact: string | null
  location: string | null
  custom: Record<string, unknown>
  change_type: string | null
  risk: string | null
  justification: string | null
  implementation_plan: string | null
  backout_plan: string | null
  test_plan: string | null
  planned_start: Date | null
  planned_end: Date | null
  cab_group_id: string | null
  root_cause: string | null
  workaround: string | null
  known_error: boolean
}>

export function TicketFields({
  type,
  config,
  staff,
  defaults = {},
  cabGroups = [],
  timeZone,
  editing,
}: {
  type: TicketType
  config: ItsmConfig
  staff: boolean
  defaults?: FieldDefaults
  cabGroups?: { id: string; name: string }[]
  timeZone: string
  editing?: boolean
}) {
  const fields = config.customFields.filter((f) => !f.ticket_types || f.ticket_types.includes(type))
  return (
    <div className="space-y-4">
      <Field label="Subject" htmlFor="subject" required>
        <input id="subject" name="subject" required minLength={3} maxLength={300} defaultValue={defaults.subject ?? ""} className="input" />
      </Field>
      <Field label={type === "change" ? "Description and scope" : "Description"} htmlFor="description" hint={type === "incident" && !editing ? "What happened, what you expected, any error messages." : undefined}>
        <textarea id="description" name="description" rows={6} defaultValue={defaults.description ?? ""} className="input" />
      </Field>
      <CategoryPicker categories={config.categories} type={type} defaultValue={defaults.category_id} />
      <PriorityPicker
        matrix={config.matrix}
        defaultImpact={defaults.impact}
        defaultUrgency={defaults.urgency}
        defaultPriority={editing ? defaults.priority : undefined}
        allowOverride={staff}
      />
      {type !== "change" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Contact (phone or extension)" htmlFor="contact">
            <input id="contact" name="contact" maxLength={200} defaultValue={defaults.contact ?? ""} className="input" />
          </Field>
          <Field label="Location" htmlFor="location">
            <input id="location" name="location" maxLength={200} defaultValue={defaults.location ?? ""} className="input" />
          </Field>
        </div>
      )}

      {type === "problem" && (
        <div className="grid gap-3">
          <Field label="Workaround" htmlFor="workaround" hint="How affected users can carry on until the root cause is fixed.">
            <textarea id="workaround" name="workaround" rows={3} defaultValue={defaults.workaround ?? ""} className="input" />
          </Field>
          {editing && (
            <>
              <Field label="Root cause" htmlFor="rootCause">
                <textarea id="rootCause" name="rootCause" rows={3} defaultValue={defaults.root_cause ?? ""} className="input" />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="hidden" name="knownError" value="false" />
                <input type="checkbox" name="knownError" value="true" defaultChecked={!!defaults.known_error} /> Known error (published workaround)
              </label>
            </>
          )}
        </div>
      )}

      {type === "change" && (
        <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-700">Change plan</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Change type" htmlFor="changeType">
              <select id="changeType" name="changeType" defaultValue={defaults.change_type ?? "normal"} className="input">
                {CHANGE_TYPES.map((c) => (
                  <option key={c} value={c}>{CHANGE_TYPE_LABELS[c]}</option>
                ))}
              </select>
            </Field>
            <Field label="Risk" htmlFor="risk">
              <select id="risk" name="risk" defaultValue={defaults.risk ?? ""} className="input">
                <option value="">—</option>
                {RISKS.map((r) => (
                  <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>
                ))}
              </select>
            </Field>
            <Field label="Approval board" htmlFor="cabGroupId">
              <select id="cabGroupId" name="cabGroupId" defaultValue={defaults.cab_group_id ?? ""} className="input">
                <option value="">Default CAB</option>
                {cabGroups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Planned start" htmlFor="plannedStart" hint={`Time zone: ${timeZone}`}>
              <input id="plannedStart" name="plannedStart" type="datetime-local" defaultValue={toLocalInput(defaults.planned_start, timeZone)} className="input" />
            </Field>
            <Field label="Planned end" htmlFor="plannedEnd">
              <input id="plannedEnd" name="plannedEnd" type="datetime-local" defaultValue={toLocalInput(defaults.planned_end, timeZone)} className="input" />
            </Field>
          </div>
          <Field label="Reason for the change" htmlFor="justification">
            <textarea id="justification" name="justification" rows={2} defaultValue={defaults.justification ?? ""} className="input" />
          </Field>
          <Field label="Implementation plan" htmlFor="implementationPlan" required={false}>
            <textarea id="implementationPlan" name="implementationPlan" rows={4} defaultValue={defaults.implementation_plan ?? ""} className="input" />
          </Field>
          <Field label="Back-out plan" htmlFor="backoutPlan">
            <textarea id="backoutPlan" name="backoutPlan" rows={3} defaultValue={defaults.backout_plan ?? ""} className="input" />
          </Field>
          <Field label="Test plan" htmlFor="testPlan">
            <textarea id="testPlan" name="testPlan" rows={2} defaultValue={defaults.test_plan ?? ""} className="input" />
          </Field>
        </fieldset>
      )}

      <CustomFieldInputs fields={fields} values={defaults.custom} />
    </div>
  )
}
