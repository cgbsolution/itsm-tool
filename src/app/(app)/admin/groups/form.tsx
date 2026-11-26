/** Group form fields (server component). */
import { Field } from "@/components/ui"
import { GROUP_KINDS, GROUP_KIND_LABELS, type GroupRow } from "@/lib/admin/groups"

export function GroupFields({ defaults, people }: { defaults?: Partial<GroupRow>; people: { id: string; full_name: string; email: string }[] }) {
  const d = defaults ?? {}
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" htmlFor="name" required>
        <input id="name" name="name" className="input" required maxLength={120} defaultValue={d.name ?? ""} />
      </Field>
      <Field label="Used for" htmlFor="kind" hint="Change Advisory Board groups approve normal and emergency changes">
        <select id="kind" name="kind" className="input" defaultValue={d.kind ?? "support"}>
          {GROUP_KINDS.map((k) => (
            <option key={k} value={k}>
              {GROUP_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description" htmlFor="description" className="sm:col-span-2">
        <input id="description" name="description" className="input" maxLength={1000} defaultValue={d.description ?? ""} />
      </Field>
      <Field label="Group email" htmlFor="email" hint="A shared mailbox or distribution list, if the group has one">
        <input id="email" name="email" type="email" className="input" maxLength={320} defaultValue={d.email ?? ""} />
      </Field>
      <Field label="Manager" htmlFor="managerId">
        <select id="managerId" name="managerId" className="input" defaultValue={d.manager_id ?? ""}>
          <option value="">— None —</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name || p.email} ({p.email})
            </option>
          ))}
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="isActive" defaultChecked={d.is_active ?? true} /> Active (inactive groups cannot receive new tickets)
      </label>
    </div>
  )
}
