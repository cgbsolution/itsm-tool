/** Shared pieces of the user pages (server components). */
import { Badge, Field, type Tone } from "@/components/ui"

type Person = { id: string; full_name: string; email: string }
type Org = { id: string; name: string; status: string }

export function UserDetailFields({
  defaults,
  people,
  organizations,
  emailEditable,
  selfId,
}: {
  defaults?: Partial<{
    full_name: string
    email: string
    department: string | null
    designation: string | null
    phone: string | null
    employee_id: string | null
    location: string | null
    manager_id: string | null
    organization_id: string | null
  }>
  people: Person[]
  organizations: Org[]
  emailEditable: boolean
  selfId?: string
}) {
  const d = defaults ?? {}
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" htmlFor="fullName" required>
        <input id="fullName" name="fullName" className="input" required maxLength={200} defaultValue={d.full_name ?? ""} />
      </Field>
      <Field label="Email" htmlFor="email" required hint={emailEditable ? undefined : "Comes from the directory or sign-in provider"}>
        {emailEditable ? (
          <input id="email" name="email" type="email" className="input" required maxLength={320} defaultValue={d.email ?? ""} />
        ) : (
          <div className="input bg-slate-50">{d.email}</div>
        )}
      </Field>
      <Field label="Department" htmlFor="department">
        <input id="department" name="department" className="input" maxLength={200} defaultValue={d.department ?? ""} />
      </Field>
      <Field label="Designation" htmlFor="designation">
        <input id="designation" name="designation" className="input" maxLength={200} defaultValue={d.designation ?? ""} />
      </Field>
      <Field label="Phone" htmlFor="phone">
        <input id="phone" name="phone" className="input" maxLength={50} defaultValue={d.phone ?? ""} />
      </Field>
      {defaults && (
        <>
          <Field label="Employee ID" htmlFor="employeeId">
            <input id="employeeId" name="employeeId" className="input" maxLength={100} defaultValue={d.employee_id ?? ""} />
          </Field>
          <Field label="Location" htmlFor="location">
            <input id="location" name="location" className="input" maxLength={200} defaultValue={d.location ?? ""} />
          </Field>
        </>
      )}
      <Field label="Manager" htmlFor="managerId" hint="Used for request approvals by the manager">
        <select id="managerId" name="managerId" className="input" defaultValue={d.manager_id ?? ""}>
          <option value="">— None —</option>
          {people
            .filter((p) => p.id !== selfId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name || p.email} ({p.email})
              </option>
            ))}
        </select>
      </Field>
      <Field label="Organisation" htmlFor="organizationId">
        <select id="organizationId" name="organizationId" className="input" defaultValue={d.organization_id ?? ""}>
          <option value="">— None —</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.status === "inactive" ? " (inactive)" : ""}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

export function UserStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === "active" ? "green" : status === "invited" ? "blue" : "red"
  const label = status === "active" ? "Active" : status === "invited" ? "Invited" : "Disabled"
  return <Badge tone={tone}>{label}</Badge>
}

export function AuthSourceBadge({ source }: { source: string }) {
  if (source === "ldap") return <Badge tone="purple" title="Signs in with LDAP / Active Directory">LDAP</Badge>
  if (source === "oidc") return <Badge tone="purple" title="Signs in with single sign-on">OIDC</Badge>
  return <span className="text-xs text-slate-500">Password</span>
}
