import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getOrganization } from "@/lib/admin/organizations"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field, KeyValues, PageHeader } from "@/components/ui"
import { deleteOrganizationAction, updateOrganizationAction } from "../actions"

export const metadata = { title: "Organisation" }

export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.users")
  const { id } = await params
  let o
  try {
    o = await getOrganization(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  return (
    <>
      <PageHeader title={o.name} back={{ href: "/admin/organizations", label: "Organisations" }} />
      <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
        <Card title="Details">
          <ActionForm action={updateOrganizationAction.bind(null, o.id)} className="space-y-3">
            <Field label="Name" htmlFor="name" required hint="Unique in this tenant">
              <input id="name" name="name" className="input" required maxLength={200} defaultValue={o.name} />
            </Field>
            <Field label="Email domain" htmlFor="domain">
              <input id="domain" name="domain" className="input" maxLength={253} defaultValue={o.domain ?? ""} />
            </Field>
            <Field label="Status" htmlFor="status">
              <select id="status" name="status" className="input" defaultValue={o.status}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </Card>
        <div className="space-y-4">
          <Card title="Usage">
            <KeyValues
              items={[
                ["People", <Link key="p" href={`/admin/users?org=${o.id}`}>{o.user_count}</Link>],
                ["Tickets", String(o.ticket_count)],
                ["Created", formatDateTime(o.created_at, actor.tenant.timezone)],
              ]}
            />
          </Card>
          <Card title="Delete">
            <p className="mb-3 text-sm text-slate-500">People, tickets and configuration items of this organisation are kept, without an organisation.</p>
            <ActionForm action={deleteOrganizationAction.bind(null, o.id)} confirm={`Delete ${o.name}? ${o.user_count} people and ${o.ticket_count} tickets lose this organisation.`}>
              <SubmitButton className="btn btn-danger">Delete organisation</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  )
}
