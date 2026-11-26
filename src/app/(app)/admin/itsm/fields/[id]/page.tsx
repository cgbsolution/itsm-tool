import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getCustomField } from "@/lib/admin/fields"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../../tabs"
import { FieldFields } from "../form"
import { deleteFieldAction, updateFieldAction } from "../../actions"

export const metadata = { title: "Edit field" }

export default async function FieldPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.itsm")
  const { id } = await params
  let f
  try {
    f = await getCustomField(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  return (
    <>
      <PageHeader title={`Edit field: ${f.label}`} back={{ href: "/admin/itsm/fields", label: "Custom fields" }} />
      <ItsmTabs active="fields" />
      <Card className="max-w-4xl">
        <ActionForm action={updateFieldAction.bind(null, f.id)} className="space-y-3">
          <FieldFields field={f} />
          <SubmitButton>Save field</SubmitButton>
        </ActionForm>
      </Card>
      <Card title="Delete" className="mt-4 max-w-4xl">
        <p className="mb-3 text-sm text-slate-500">
          Values already saved on tickets stay in the data but are no longer shown. Deactivating hides the field and keeps it for later.
        </p>
        <ActionForm action={deleteFieldAction.bind(null, f.id)} confirm={`Delete the field ${f.label}?`}>
          <SubmitButton className="btn btn-danger">Delete field</SubmitButton>
        </ActionForm>
      </Card>
    </>
  )
}
