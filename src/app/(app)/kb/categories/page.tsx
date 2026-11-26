import { requirePermission } from "@/lib/auth/session"
import { kbCategories } from "@/lib/kb/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, EmptyState, PageHeader } from "@/components/ui"
import { createKbCategoryAction, deleteKbCategoryAction, updateKbCategoryAction } from "../actions"

export const metadata = { title: "Knowledge categories" }

export default async function KbCategoriesPage() {
  const actor = await requirePermission("kb.publish")
  const categories = await kbCategories(actor)
  return (
    <>
      <PageHeader title="Knowledge categories" subtitle="Group articles so readers can browse them. Deleting a category keeps its articles." back={{ href: "/kb", label: "Knowledge base" }} />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card title={`Categories (${categories.length})`}>
          {categories.length === 0 ? (
            <EmptyState title="No categories yet">Add one on the right, e.g. Accounts and passwords, Network and VPN, Email, Printing.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {categories.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
                  <ActionForm action={updateKbCategoryAction.bind(null, c.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <input name="name" defaultValue={c.name} required maxLength={100} className="input min-w-0 flex-1" aria-label="Name" />
                    <input name="sortOrder" type="number" defaultValue={c.sort_order} className="input w-20" aria-label="Sort order" title="Sort order" />
                    <SubmitButton className="btn btn-sm">Save</SubmitButton>
                  </ActionForm>
                  <span className="w-20 text-right text-xs text-slate-500">{c.articles} articles</span>
                  <ActionForm action={deleteKbCategoryAction.bind(null, c.id)} confirm={`Delete the category "${c.name}"? Its ${c.articles} articles stay, without a category.`}>
                    <SubmitButton className="btn btn-sm btn-ghost text-red-600">Delete</SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Add a category">
          <ActionForm action={createKbCategoryAction} resetOnSuccess className="space-y-3">
            <div>
              <label className="label" htmlFor="new-name">Name</label>
              <input id="new-name" name="name" required maxLength={100} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="new-sort">Sort order</label>
              <input id="new-sort" name="sortOrder" type="number" defaultValue={(categories.at(-1)?.sort_order ?? 0) + 10} className="input" />
              <p className="hint">Lower numbers come first.</p>
            </div>
            <SubmitButton>Add category</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  )
}
