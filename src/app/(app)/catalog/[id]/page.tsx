import Link from "next/link"
import { notFound } from "next/navigation"
import { requireActor, can } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getCatalogItem } from "@/lib/catalog/queries"
import { normalizeFields, normalizeTasks } from "@/lib/catalog/forms"
import { renderMarkdown } from "@/lib/kb/markdown"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, PageHeader } from "@/components/ui"
import { submitRequestAction } from "../actions"
import { RequestFields } from "../fields"

export const metadata = { title: "Request" }

export default async function CatalogItemPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor()
  const { id } = await params
  let item
  try {
    item = await getCatalogItem(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const fields = normalizeFields(item.form_fields)
  const tasks = normalizeTasks(item.task_templates)
  const canRequest = can(actor, "ticket.create") && !item.preview

  return (
    <>
      <PageHeader
        back={{ href: "/catalog", label: "Service catalog" }}
        title={item.name}
        subtitle={item.short_description ?? item.category_name ?? undefined}
        actions={
          can(actor, "catalog.manage") && (
            <Link className="btn" href={`/catalog/manage/items/${item.id}`}>
              Edit item
            </Link>
          )
        }
      />
      {item.preview && (
        <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          Preview: this item is {item.is_active ? "visible to IT staff only" : "inactive and not shown in the catalog"}. Requests cannot be submitted from a preview.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          {item.description?.trim() && (
            <Card>
              {/* safe: renderMarkdown escapes all HTML first and allow-lists URLs */}
              <div className="md text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.description) }} />
            </Card>
          )}
          <Card title="Your request">
            <ActionForm action={submitRequestAction.bind(null, item.id)} className="space-y-4">
              {fields.length > 0 ? <RequestFields fields={fields} /> : <p className="text-sm text-slate-600">No details needed: just submit the request.</p>}
              <div>
                <label className="label" htmlFor="files">
                  Attachments
                </label>
                <input id="files" type="file" name="files" multiple className="block w-full text-sm" />
                <p className="hint">Optional: quotes, screenshots or forms. Up to 10 files.</p>
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                {canRequest ? (
                  <SubmitButton pendingText="Submitting…">Submit request</SubmitButton>
                ) : (
                  <span className="text-sm text-slate-500">{item.preview ? "Preview only" : "You cannot raise requests."}</span>
                )}
              </div>
            </ActionForm>
          </Card>
        </div>
        <aside className="space-y-4">
          <Card title="What happens next">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
              <li>A request ticket is created for you.</li>
              {item.requires_approval && item.approve_by_manager && <li>Your manager is asked to approve it.</li>}
              {item.requires_approval && item.approver_group_id && (
                <li>
                  {item.approver_group_name ?? "An approver group"} approves it ({item.approval_mode === "all" ? "every member" : "any one member"}).
                </li>
              )}
              <li>{item.fulfilment_group_name ? `${item.fulfilment_group_name} fulfils it` : "The IT team fulfils it"}{tasks.length ? ` (${tasks.length} step${tasks.length === 1 ? "" : "s"})` : ""}.</li>
              <li>You are notified as it moves on, and can follow it under <Link href="/tickets">My tickets</Link>.</li>
            </ol>
            {item.requires_approval && (
              <p className="mt-3">
                <Badge tone="amber">Needs approval</Badge>
              </p>
            )}
          </Card>
        </aside>
      </div>
    </>
  )
}
