import { requirePermission } from "@/lib/auth/session"
import { peopleOptions, roleCatalog } from "@/lib/admin/users"
import { organizationOptions } from "@/lib/admin/organizations"
import { loadTenantSettings } from "@/lib/itsm/config"
import { ActionForm, Reveal, SubmitButton } from "@/components/client"
import { Card, Field, PageHeader } from "@/components/ui"
import { UserDetailFields } from "../form"
import { createUserAction } from "../actions"

export const metadata = { title: "New user" }

export default async function NewUserPage() {
  const actor = await requirePermission("admin.users")
  const [roles, people, orgs, settings] = await Promise.all([roleCatalog(actor), peopleOptions(actor), organizationOptions(actor), loadTenantSettings(actor.tenantId)])
  const grantable = roles.filter((r) => r.grantable)
  return (
    <>
      <PageHeader title="New user" subtitle={`Creates a local account in ${actor.tenant.name}`} back={{ href: "/admin/users", label: "Users" }} />
      <ActionForm action={createUserAction} className="max-w-3xl space-y-4">
        <Card title="Details">
          <UserDetailFields people={people} organizations={orgs} emailEditable />
        </Card>
        <Card title="Access">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Role" htmlFor="role" required hint="Roles that hold permissions you do not have are not offered.">
              <select id="role" name="role" className="input" required defaultValue="user">
                <optgroup label="Built-in roles">
                  {grantable
                    .filter((r) => r.system)
                    .map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                </optgroup>
                {grantable.some((r) => !r.system) && (
                  <optgroup label="Custom roles">
                    {grantable
                      .filter((r) => !r.system)
                      .map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.name}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </Field>
            <Field label="Password" htmlFor="mode" required>
              <select id="mode" name="mode" className="input" defaultValue="invite">
                <option value="invite">Send an invitation to set a password</option>
                <option value="password">Set a temporary password now</option>
              </select>
            </Field>
            <Reveal when="mode=password">
              <Field
                label="Temporary password"
                htmlFor="password"
                className="sm:col-span-2"
                hint={`At least ${settings.password_min_length} characters. They must change it when they first sign in. Share it securely.`}
              >
                <input id="password" name="password" type="password" className="input" autoComplete="new-password" minLength={settings.password_min_length} maxLength={200} />
              </Field>
            </Reveal>
          </div>
          <p className="hint mt-3">
            An invitation emails a link that is valid for 72 hours; the account shows as “Invited” until a password is set. People who sign in with LDAP or single sign-on can get their
            account automatically at first sign-in, depending on the sign-in provider settings.
          </p>
        </Card>
        <SubmitButton pendingText="Creating…">Create user</SubmitButton>
      </ActionForm>
    </>
  )
}
