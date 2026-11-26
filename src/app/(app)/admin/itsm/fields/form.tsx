/** Custom field form (server component). */
import type { CustomFieldRow } from "@/lib/itsm/config"
import { FIELD_TYPES, FIELD_TYPE_LABELS } from "@/lib/admin/fields"
import { Field } from "@/components/ui"
import { TypeChecks } from "../parts"

export function FieldFields({ field }: { field?: CustomFieldRow }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="Key"
        htmlFor="key"
        required={!field}
        hint={field ? "The key cannot change: ticket values are stored under it." : "Lowercase letters, digits and underscores, starting with a letter (e.g. asset_tag). It cannot be changed later."}
      >
        {field ? (
          <div className="input bg-slate-50 font-mono">{field.key}</div>
        ) : (
          <input id="key" name="key" className="input font-mono" required pattern="[a-z][a-z0-9_]{0,40}" maxLength={41} />
        )}
      </Field>
      <Field label="Label" htmlFor="label" required>
        <input id="label" name="label" className="input" required maxLength={100} defaultValue={field?.label ?? ""} />
      </Field>
      <Field label="Type" htmlFor="fieldType" required hint={field ? "Changing the type does not convert values already saved." : undefined}>
        <select id="fieldType" name="fieldType" className="input" defaultValue={field?.field_type ?? "text"}>
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Order" htmlFor="sortOrder" hint="Lower numbers come first">
        <input id="sortOrder" name="sortOrder" type="number" className="input" defaultValue={field?.sort_order ?? ""} />
      </Field>
      <Field label="Options" htmlFor="options" hint="For “Pick one” and “Pick several”: one option per line" className="sm:col-span-2">
        <textarea id="options" name="options" className="input" rows={4} defaultValue={field?.options.join("\n") ?? ""} />
      </Field>
      <Field label="Help text" htmlFor="helpText" className="sm:col-span-2" hint="Shown under the field (for “Yes / no”, it is the checkbox label)">
        <input id="helpText" name="helpText" className="input" maxLength={500} defaultValue={field?.help_text ?? ""} />
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="label">Record types</legend>
        <TypeChecks selected={field?.ticket_types ?? null} />
      </fieldset>
      <div className="flex flex-wrap gap-4 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="required" defaultChecked={field?.required ?? false} /> Required
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={field?.is_active ?? true} /> Active (shown on tickets)
        </label>
      </div>
    </div>
  )
}
