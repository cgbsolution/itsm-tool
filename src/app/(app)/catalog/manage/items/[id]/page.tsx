import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { adminItem, itemFormOptions } from "@/lib/catalog/queries"
import { FIELD_TYPES, FIELD_TYPE_LABELS, normalizeFields, normalizeTasks, type FormField } from "@/lib/catalog/forms"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, PageHeader } from "@/components/ui"
import { deleteItemAction, saveFormAction, saveTasksAction, updateItemAction } from "../../actions"
import { ItemFields } from "../../item-form"

export const metadata = { title: "Edit catalog item" }

const BLANK_ROWS = 3

function BuilderRow({ i, f, sort }: { i: number; f?: FormField; sort: number }) {
  const n = (k: string) => `rows.${i}.${k}`
  return (
    <tr className={f ? "" : "bg-slate-50/60"}>
      <td className="w-16 align-top">
        <input name={n("sort")} type="number" defaultValue={sort} className="input px-2" aria-label={`Row ${i + 1} order`} />
      </td>
      <td className="w-40 align-top">
        <input name={n("key")} defaultValue={f?.key ?? ""} className="input font-mono text-xs" placeholder="e.g. needed_by" pattern="[a-z][a-z0-9_]{0,40}" title="Lower-case letters, digits and _; start with a letter" aria-label={`Row ${i + 1} key`} />
      </td>
      <td className="min-w-44 align-top">
        <input name={n("label")} defaultValue={f?.label ?? ""} className="input" placeholder={f ? "" : "New field label"} maxLength={200} aria-label={`Row ${i + 1} label`} />
      </td>
      <td className="w-40 align-top">
        <select name={n("type")} defaultValue={f?.type ?? "text"} className="input" aria-label={`Row ${i + 1} type`}>
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </td>
      <td className="min-w-44 align-top">
        <textarea name={n("options")} defaultValue={f?.options.join("\n") ?? ""} rows={2} className="input text-xs" placeholder="Choices: one per line" aria-label={`Row ${i + 1} options`} />
      </td>
      <td className="w-12 text-center align-top">
        <input type="checkbox" name={n("required")} defaultChecked={f?.required ?? false} className="mt-2.5" aria-label={`Row ${i + 1} required`} />
      </td>
      <td className="min-w-44 align-top">
        <input name={n("help")} defaultValue={f?.help ?? ""} className="input" maxLength={500} aria-label={`Row ${i + 1} help text`} />
      </td>
      <td className="w-12 text-center align-top">
        {f && <input type="checkbox" name={n("remove")} className="mt-2.5" aria-label={`Remove row ${i + 1}`} />}
      </td>
    </tr>
  )
}

export default async function EditCatalogItemPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("catalog.manage")
  const { id } = await params
  let item
  try {
    item = await adminItem(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const options = await itemFormOptions(actor)
  const fields = normalizeFields(item.form_fields)
  const tasks = normalizeTasks(item.task_templates)
  const rowCount = fields.length + BLANK_ROWS

  return (
    <>
      <PageHeader
        title={item.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {item.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
            {item.visibility === "staff" && <Badge tone="purple">IT staff only</Badge>}
            {item.requires_approval && <Badge tone="amber">Needs approval</Badge>}
            <span>
              {fields.length} form fields · {tasks.length} tasks
            </span>
          </span>
        }
        back={{ href: "/catalog/manage", label: "Manage catalog" }}
        actions={
          <Link className="btn" href={`/catalog/${item.id}`}>
            {item.is_active && item.visibility === "all" ? "View in catalog" : "Preview"}
          </Link>
        }
      />

      <div className="space-y-4">
        <Card title="Details">
          <ActionForm action={updateItemAction.bind(null, item.id)}>
            <ItemFields item={item} options={options} />
            <div className="mt-4 flex justify-end border-t border-slate-100 pt-4">
              <SubmitButton pendingText="Saving…">Save details</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <Card title="Request form">
          <p className="mb-3 text-sm text-slate-600">
            One row per question. Keys are stored with the request (lower-case letters, digits and _; unique). Fill in a blank row to add a field, tick
            Remove to delete one, and change the order numbers to reorder. Choice fields need their options, one per line. The first short-text answer is added to the ticket subject.
          </p>
          <ActionForm action={saveFormAction.bind(null, item.id)}>
            <input type="hidden" name="rowCount" value={rowCount} />
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Key</th>
                    <th>Label</th>
                    <th>Type</th>
                    <th>Options</th>
                    <th>Required</th>
                    <th>Help text</th>
                    <th>Remove</th>
                  </tr>
                </thead>
                {/* remount the rows after each save so blank rows come back empty */}
                <tbody key={new Date(item.updated_at).getTime()}>
                  {fields.map((f, i) => (
                    <BuilderRow key={f.key} i={i} f={f} sort={(i + 1) * 10} />
                  ))}
                  {Array.from({ length: BLANK_ROWS }, (_, k) => (
                    <BuilderRow key={`new-${k}`} i={fields.length + k} sort={(fields.length + k + 1) * 10} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="hint">Need more rows? Save, and three new blank rows appear.</p>
              <SubmitButton pendingText="Saving…">Save form</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Card title="Fulfilment tasks">
            <ActionForm action={saveTasksAction.bind(null, item.id)} className="space-y-2">
              <label className="label" htmlFor="tasks">
                Tasks added to every request, one per line
              </label>
              <textarea id="tasks" name="tasks" rows={6} className="input" defaultValue={tasks.map((t) => t.title).join("\n")} placeholder={"Order the device\nInstall the standard image\nHand over to the user"} />
              <div className="flex justify-end">
                <SubmitButton>Save tasks</SubmitButton>
              </div>
            </ActionForm>
          </Card>
          <Card title="Delete item">
            <p className="mb-3 text-sm text-slate-600">Existing requests keep their answers but lose the link to this item. To stop offering it, untick Active instead.</p>
            <ActionForm action={deleteItemAction.bind(null, item.id)} confirm={`Delete "${item.name}" permanently? This is recorded in the audit log.`}>
              <SubmitButton className="btn btn-danger">Delete item</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  )
}
