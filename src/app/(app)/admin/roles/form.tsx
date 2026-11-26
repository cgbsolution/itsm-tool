/** Permission checkboxes grouped by prefix (server component). */
import type { Permission } from "@/lib/auth/permissions"
import { permissionGroups } from "@/lib/admin/rules"

export function PermissionChecks({ selected, held, superadmin }: { selected: readonly string[]; held: Set<Permission>; superadmin: boolean }) {
  const groups = permissionGroups()
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {groups.map((g) => (
        <fieldset key={g.prefix} className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">{g.label}</legend>
          <div className="space-y-2">
            {g.items.map((p) => {
              const checked = selected.includes(p.key)
              const allowed = superadmin || held.has(p.key)
              return (
                <label key={p.key} className={`flex items-start gap-2 text-sm ${allowed ? "" : "opacity-60"}`} title={allowed ? undefined : "You do not hold this permission, so you cannot grant or remove it"}>
                  <input type="checkbox" name="permissions" value={p.key} defaultChecked={checked} disabled={!allowed} className="mt-0.5" />
                  {!allowed && checked && <input type="hidden" name="permissions" value={p.key} />}
                  <span>
                    {p.description}
                    <span className="block font-mono text-[11px] text-slate-400">{p.key}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

/** Read-only list of a role's permissions, grouped. */
export function PermissionList({ permissions }: { permissions: readonly string[] }) {
  const groups = permissionGroups({ includeTenants: true })
    .map((g) => ({ ...g, items: g.items.filter((p) => permissions.includes(p.key)) }))
    .filter((g) => g.items.length)
  if (!groups.length) return <p className="text-sm text-slate-500">No permissions beyond what every signed-in person can do.</p>
  return (
    <div className="space-y-2 text-sm">
      {groups.map((g) => (
        <div key={g.prefix}>
          <div className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{g.label}</div>
          <ul className="ml-4 list-disc text-slate-700">
            {g.items.map((p) => (
              <li key={p.key}>{p.description}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
