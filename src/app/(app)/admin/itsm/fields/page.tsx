import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listCustomFieldsAdmin, FIELD_TYPE_LABELS } from "@/lib/admin/fields"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, EmptyState, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../tabs"
import { Note, typesLabel } from "../parts"
import { FieldFields } from "./form"
import { createFieldAction } from "../actions"

export const metadata = { title: "Custom fields" }

export default async function FieldsPage() {
  const actor = await requirePermission("admin.itsm")
  const fields = await listCustomFieldsAdmin(actor)
  return (
    <>
      <PageHeader title="ITSM settings" subtitle="Extra fields on tickets" back={{ href: "/admin/itsm", label: "ITSM settings" }} />
      <ItsmTabs active="fields" />
      <Note>The key of a field cannot change once it is created: values on tickets are stored under it. To retire a field, deactivate it.</Note>
      {fields.length === 0 ? (
        <EmptyState title="No custom fields">Add one below, for example an asset tag or a cost centre.</EmptyState>
      ) : (
        <div className="card mb-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Label</th>
                <th>Key</th>
                <th>Type</th>
                <th>Record types</th>
                <th>Required</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id} className={f.is_active ? "" : "opacity-60"}>
                  <td className="text-slate-500">{f.sort_order}</td>
                  <td>
                    <Link href={`/admin/itsm/fields/${f.id}`} className="font-medium">
                      {f.label}
                    </Link>
                    {f.help_text && <div className="text-xs text-slate-500">{f.help_text}</div>}
                  </td>
                  <td className="font-mono text-xs">{f.key}</td>
                  <td>
                    {FIELD_TYPE_LABELS[f.field_type]}
                    {f.options.length > 0 && <div className="text-xs text-slate-500">{f.options.length} options</div>}
                  </td>
                  <td className="text-xs text-slate-600">{typesLabel(f.ticket_types)}</td>
                  <td>{f.required ? "Yes" : "No"}</td>
                  <td>{f.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="card max-w-4xl" open={fields.length === 0}>
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Add a field</summary>
        <div className="border-t border-slate-100 p-4">
          <ActionForm action={createFieldAction} className="space-y-3">
            <FieldFields />
            <SubmitButton>Add field</SubmitButton>
          </ActionForm>
        </div>
      </details>
    </>
  )
}
