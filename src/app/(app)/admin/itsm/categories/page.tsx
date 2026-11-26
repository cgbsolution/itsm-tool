import { requirePermission } from "@/lib/auth/session"
import { listCategoriesAdmin, type AdminCategory } from "@/lib/admin/itsm"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../tabs"
import { TypeChecks, typesLabel } from "../parts"
import { createCategoryAction, deleteCategoryAction, updateCategoryAction } from "../actions"

export const metadata = { title: "Categories" }

function CategoryRowForm({ c, top, usedBy }: { c: AdminCategory; top: boolean; usedBy: number }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <ActionForm action={updateCategoryAction.bind(null, c.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <input name="name" defaultValue={c.name} className={`input w-56 ${top ? "font-medium" : ""}`} required maxLength={100} aria-label="Name" />
        <input name="sortOrder" type="number" defaultValue={c.sort_order} className="input w-20" aria-label="Order" title="Order (lower first)" />
        {top && <TypeChecks selected={c.ticket_types} compact />}
        <label className="flex items-center gap-1.5 text-xs text-slate-700">
          <input type="checkbox" name="isActive" defaultChecked={c.is_active} /> Active
        </label>
        <SubmitButton className="btn btn-sm">Save</SubmitButton>
      </ActionForm>
      <div className="flex items-center gap-2 pt-1">
        {!c.is_active && <Badge>Inactive</Badge>}
        {usedBy > 0 ? (
          <span className="text-xs text-slate-500" title="Used categories cannot be deleted; deactivate them instead">
            {usedBy} ticket{usedBy === 1 ? "" : "s"}
          </span>
        ) : (
          <ActionForm action={deleteCategoryAction.bind(null, c.id)} confirm={`Delete ${c.name}${top ? " and its sub-categories" : ""}?`}>
            <SubmitButton className="btn btn-sm btn-ghost text-red-600">Delete</SubmitButton>
          </ActionForm>
        )}
      </div>
    </div>
  )
}

export default async function CategoriesPage() {
  const actor = await requirePermission("admin.itsm")
  const cats = await listCategoriesAdmin(actor)
  const parents = cats.filter((c) => !c.parent_id)
  const childrenOf = (id: string) => cats.filter((c) => c.parent_id === id)
  return (
    <>
      <PageHeader title="ITSM settings" subtitle="Categories and sub-categories offered when a ticket is raised" back={{ href: "/admin/itsm", label: "ITSM settings" }} />
      <ItsmTabs active="categories" />
      <p className="hint mb-4">
        Order: lower numbers come first. Record types apply to a category and its sub-categories; ticking none is the same as ticking all. Renaming does not change tickets already logged, which keep the name they
        were filed under. A category that tickets use cannot be deleted; deactivate it so it is no longer offered.
      </p>
      <Card title="Add a category" className="mb-4">
        <ActionForm action={createCategoryAction.bind(null, null)} className="flex flex-wrap items-center gap-2" resetOnSuccess>
          <input name="name" placeholder="Category name" className="input w-64" required maxLength={100} aria-label="Category name" />
          <input name="sortOrder" type="number" placeholder="Order" className="input w-24" aria-label="Order" />
          <TypeChecks selected={null} compact />
          <SubmitButton className="btn btn-primary btn-sm">Add category</SubmitButton>
        </ActionForm>
      </Card>
      {parents.length === 0 ? (
        <EmptyState title="No categories yet">Add the first category above.</EmptyState>
      ) : (
        <div className="space-y-3">
          {parents.map((p) => {
            const subs = childrenOf(p.id)
            const usedBy = p.ticket_count + subs.reduce((n, s) => n + s.ticket_count, 0)
            return (
              <section key={p.id} className={`card ${p.is_active ? "" : "opacity-75"}`}>
                <div className="border-b border-slate-100 px-4 py-3">
                  <CategoryRowForm c={p} top usedBy={usedBy} />
                  <div className="mt-1 text-xs text-slate-500">{typesLabel(p.ticket_types)}</div>
                </div>
                <details className="px-4 py-2">
                  <summary className="cursor-pointer text-sm text-slate-600">
                    {subs.length} sub-categor{subs.length === 1 ? "y" : "ies"}
                  </summary>
                  <div className="mt-2 space-y-2 border-l-2 border-slate-100 pl-4">
                    {subs.map((s) => (
                      <CategoryRowForm key={s.id} c={s} top={false} usedBy={s.ticket_count} />
                    ))}
                    <ActionForm action={createCategoryAction.bind(null, p.id)} className="flex flex-wrap items-center gap-2 pt-1" resetOnSuccess>
                      <input name="name" placeholder={`New sub-category of ${p.name}`} className="input w-64" required maxLength={100} aria-label="Sub-category name" />
                      <input name="sortOrder" type="number" placeholder="Order" className="input w-20" aria-label="Order" />
                      <SubmitButton className="btn btn-sm">Add sub-category</SubmitButton>
                    </ActionForm>
                  </div>
                </details>
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}
