import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getCustomRole } from "@/lib/admin/roles"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field, PageHeader } from "@/components/ui"
import { PermissionChecks } from "../form"
import { deleteRoleAction, updateRoleAction } from "../actions"

export const metadata = { title: "Role" }

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.users")
  const { id } = await params
  let r
  try {
    r = await getCustomRole(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  return (
    <>
      <PageHeader
        title={r.name}
        subtitle={
          <>
            Custom role <span className="font-mono">{r.key}</span> ·{" "}
            <Link href={`/admin/users?role=${encodeURIComponent(r.key)}`}>
              {r.user_count} {r.user_count === 1 ? "person" : "people"}
            </Link>
          </>
        }
        back={{ href: "/admin/roles", label: "Roles" }}
      />
      <ActionForm action={updateRoleAction.bind(null, r.id)} className="max-w-4xl space-y-4">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Key" hint="The key cannot be changed: accounts refer to it.">
              <div className="input bg-slate-50 font-mono">{r.key}</div>
            </Field>
            <Field label="Name" htmlFor="name" required>
              <input id="name" name="name" className="input" required maxLength={100} defaultValue={r.name} />
            </Field>
            <Field label="Description" htmlFor="description" className="sm:col-span-2">
              <input id="description" name="description" className="input" maxLength={500} defaultValue={r.description ?? ""} />
            </Field>
          </div>
        </Card>
        <Card title="Permissions">
          <PermissionChecks selected={r.permissions} held={actor.permissions} superadmin={actor.isSuperadmin} />
        </Card>
        <SubmitButton>Save role</SubmitButton>
      </ActionForm>
      <Card title="Delete" className="mt-6 max-w-4xl">
        <p className="mb-3 text-sm text-slate-500">
          {r.user_count > 0 ? `${r.user_count} ${r.user_count === 1 ? "person holds" : "people hold"} this role. Give them another role before deleting it.` : "Nobody holds this role."}
        </p>
        <ActionForm action={deleteRoleAction.bind(null, r.id)} confirm={`Delete the role ${r.name}?`}>
          <SubmitButton className="btn btn-danger">Delete role</SubmitButton>
        </ActionForm>
      </Card>
    </>
  )
}
