/** Inputs for a catalog item's request form (server component). Field names are "f.<key>". */
import { Field } from "@/components/ui"
import type { FormField } from "@/lib/catalog/forms"

function Control({ f }: { f: FormField }) {
  const name = `f.${f.key}`
  const id = `f-${f.key}`
  const common = { id, name, required: f.required, className: "input", "aria-describedby": f.help ? `${id}-help` : undefined }
  switch (f.type) {
    case "textarea":
      return <textarea {...common} rows={4} maxLength={10_000} />
    case "number":
      return <input {...common} type="number" step="any" inputMode="decimal" />
    case "date":
      return <input {...common} type="date" min="1900-01-01" max="2200-12-31" />
    case "email":
      return <input {...common} type="email" maxLength={320} autoComplete="email" />
    case "select":
      return (
        <select {...common} defaultValue="">
          <option value="">— Choose —</option>
          {f.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    default:
      return <input {...common} type="text" maxLength={500} />
  }
}

export function RequestFields({ fields }: { fields: FormField[] }) {
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const help = f.help ? (
          <p className="hint" id={`f-${f.key}-help`}>
            {f.help}
          </p>
        ) : null
        if (f.type === "checkbox") {
          return (
            <div key={f.key}>
              <label className="flex items-start gap-2 text-sm text-slate-800">
                <input type="checkbox" name={`f.${f.key}`} required={f.required} className="mt-0.5" />
                <span>
                  {f.label}
                  {f.required && <span className="text-red-600"> *</span>}
                </span>
              </label>
              {help}
            </div>
          )
        }
        if (f.type === "multiselect") {
          return (
            <fieldset key={f.key}>
              <legend className="label">
                {f.label}
                {f.required && <span className="text-red-600"> *</span>}
              </legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {f.options.map((o) => (
                  <label key={o} className="flex items-center gap-2 text-sm text-slate-800">
                    <input type="checkbox" name={`f.${f.key}`} value={o} /> {o}
                  </label>
                ))}
              </div>
              {help}
            </fieldset>
          )
        }
        return (
          <Field key={f.key} label={f.label} htmlFor={`f-${f.key}`} required={f.required}>
            <Control f={f} />
            {help}
          </Field>
        )
      })}
    </div>
  )
}
