/** Create / edit form for a CI class (server component around the client attribute editor). */
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field } from "@/components/ui"
import { CLASS_CATEGORIES } from "@/lib/cmdb/vocab"
import type { CiAttribute } from "@/lib/cmdb/classes"
import { saveClassAction } from "../actions"
import { AttributeEditor } from "./attribute-editor"

const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase())

export function ClassForm({ cls }: { cls?: { id: string; key: string; name: string; category: string; is_active: boolean; attributes: CiAttribute[] } }) {
  return (
    <ActionForm action={saveClassAction.bind(null, cls?.id ?? null)} className="max-w-5xl space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Key" htmlFor="key" required={!cls} hint={cls ? "The key cannot be changed." : "Lower-case, e.g. ups or badge_reader. Used in imports."}>
            {cls ? (
              <input id="key" className="input bg-slate-50 font-mono text-xs" value={cls.key} readOnly />
            ) : (
              <input id="key" name="key" className="input font-mono text-xs" required pattern="[a-z][a-z0-9_]{0,40}" maxLength={41} />
            )}
          </Field>
          <Field label="Name" htmlFor="name" required>
            <input id="name" name="name" className="input" required maxLength={120} defaultValue={cls?.name ?? ""} />
          </Field>
          <Field label="Category" htmlFor="category" required>
            <select id="category" name="category" className="input" defaultValue={cls?.category ?? "hardware"}>
              {CLASS_CATEGORIES.map((c) => (
                <option key={c} value={c}>{cap(c)}</option>
              ))}
            </select>
          </Field>
        </div>
        {cls && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={cls.is_active} /> Active (inactive classes cannot be chosen for new items)
          </label>
        )}
      </Card>
      <Card title="Attributes">
        <AttributeEditor initial={cls?.attributes ?? []} />
      </Card>
      <SubmitButton pendingText="Saving…">{cls ? "Save class" : "Create class"}</SubmitButton>
    </ActionForm>
  )
}
