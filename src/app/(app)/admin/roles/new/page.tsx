import { requirePermission } from "@/lib/auth/session"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field, PageHeader } from "@/components/ui"
import { PermissionChecks } from "../form"
import { createRoleAction } from "../actions"

export const metadata = { title: "New role" }

export default async function NewRolePage() {
  const actor = await requirePermission("admin.users")
  return (
    <>
      <PageHeader title="New custom role" back={{ href: "/admin/roles", label: "Roles" }} />
      <ActionForm action={createRoleAction} className="max-w-4xl space-y-4">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Key" htmlFor="key" required hint="Lowercase letters, digits and underscores, starting with a letter (e.g. service_desk_lead). It cannot be changed later.">
              <input id="key" name="key" className="input font-mono" required pattern="[a-z][a-z0-9_]{1,40}" maxLength={41} />
            </Field>
            <Field label="Name" htmlFor="name" required>
              <input id="name" name="name" className="input" required maxLength={100} />
            </Field>
            <Field label="Description" htmlFor="description" className="sm:col-span-2">
              <input id="description" name="description" className="input" maxLength={500} />
            </Field>
          </div>
        </Card>
        <Card title="Permissions">
          <PermissionChecks selected={[]} held={actor.permissions} superadmin={actor.isSuperadmin} />
        </Card>
        <SubmitButton>Create role</SubmitButton>
      </ActionForm>
    </>
  )
}
