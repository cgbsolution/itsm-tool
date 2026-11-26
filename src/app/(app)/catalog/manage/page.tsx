import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { adminCatalog } from "@/lib/catalog/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui"
import { PRIORITY_LABELS } from "@/lib/itsm/vocab"
import { createCatalogCategoryAction, deleteCatalogCategoryAction, starterItemsAction, updateCatalogCategoryAction } from "./actions"

export const metadata = { title: "Manage catalog" }

export default async function ManageCatalogPage() {
  const actor = await requirePermission("catalog.manage")
  const { categories, items } = await adminCatalog(actor)
  return (
    <>
      <PageHeader
        title="Manage the service catalog"
        subtitle="Items, their request forms, approvals and fulfilment. Changes are recorded in the audit log."
        back={{ href: "/catalog", label: "Service catalog" }}
        actions={
          <>
            <ActionForm action={starterItemsAction} confirm="Create the starter items New laptop, Software installation, VPN access and Shared mailbox access? Existing items with these names are left alone.">
              <SubmitButton className="btn" pendingText="Creating…">
                Create starter items
              </SubmitButton>
            </ActionForm>
            <Link className="btn btn-primary" href="/catalog/manage/items/new">
              New item
            </Link>
          </>
        }
      />

      <div className="space-y-4">
        <Card title={`Items (${items.length})`} bodyClassName="p-0">
          {items.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No items yet">Create one with New item, or use Create starter items for four typical requests with ready-made forms.</EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th>Approval</th>
                    <th>Fulfilment</th>
                    <th>Form</th>
                    <th>Priority</th>
                    <th>Sort</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="max-w-xs">
                        <Link href={`/catalog/manage/items/${i.id}`} className="font-medium">
                          {i.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {!i.is_active && <Badge>Inactive</Badge>}
                          {i.visibility === "staff" && <Badge tone="purple">IT staff only</Badge>}
                        </div>
                      </td>
                      <td className="text-slate-600">{i.category_name ?? "—"}</td>
                      <td className="text-xs text-slate-600">
                        {i.requires_approval
                          ? [i.approve_by_manager && "Manager", i.approver_group_name && `${i.approver_group_name} (${i.approval_mode})`].filter(Boolean).join(" → ") || "Not configured"
                          : "None"}
                      </td>
                      <td className="text-xs text-slate-600">
                        {i.fulfilment_group_name ?? "IT queue"}
                        {i.task_count > 0 && <div className="text-slate-400">{i.task_count} tasks</div>}
                      </td>
                      <td className="text-xs text-slate-600">{i.field_count} fields</td>
                      <td className="text-xs text-slate-600">{PRIORITY_LABELS[i.default_priority]}</td>
                      <td className="text-xs text-slate-500">{i.sort_order}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Card title={`Categories (${categories.length})`}>
            {categories.length === 0 ? (
              <p className="text-sm text-slate-500">No categories yet. Items without a category are listed under "Requests".</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {categories.map((c) => (
                  <li key={c.id} className="py-2.5">
                    <ActionForm action={updateCatalogCategoryAction.bind(null, c.id)} className="grid gap-2 sm:grid-cols-[1fr_1.5fr_5rem_auto_auto] sm:items-center">
                      <input name="name" defaultValue={c.name} required maxLength={100} className="input" aria-label="Name" />
                      <input name="description" defaultValue={c.description ?? ""} maxLength={1000} className="input" placeholder="Description" aria-label="Description" />
                      <input name="sortOrder" type="number" defaultValue={c.sort_order} className="input" aria-label="Sort order" title="Sort order" />
                      <label className="flex items-center gap-1.5 text-sm whitespace-nowrap">
                        <input type="checkbox" name="isActive" defaultChecked={c.is_active} /> Active
                      </label>
                      <SubmitButton className="btn btn-sm">Save</SubmitButton>
                    </ActionForm>
                    <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                      <span>{c.items} items</span>
                      <ActionForm action={deleteCatalogCategoryAction.bind(null, c.id)} confirm={`Delete the category "${c.name}"? Its ${c.items} items stay, without a category.`}>
                        <button className="text-xs text-slate-400 hover:text-red-600">Delete</button>
                      </ActionForm>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Add a category">
            <ActionForm action={createCatalogCategoryAction} resetOnSuccess className="space-y-3">
              <div>
                <label className="label" htmlFor="cat-name">Name</label>
                <input id="cat-name" name="name" required maxLength={100} className="input" placeholder="Hardware" />
              </div>
              <div>
                <label className="label" htmlFor="cat-desc">Description</label>
                <input id="cat-desc" name="description" maxLength={1000} className="input" placeholder="Computers, phones and accessories" />
              </div>
              <div className="grid grid-cols-2 items-end gap-3">
                <div>
                  <label className="label" htmlFor="cat-sort">Sort order</label>
                  <input id="cat-sort" name="sortOrder" type="number" defaultValue={(categories.at(-1)?.sort_order ?? 0) + 10} className="input" />
                </div>
                <label className="flex items-center gap-1.5 pb-2 text-sm">
                  <input type="checkbox" name="isActive" defaultChecked /> Active
                </label>
              </div>
              <SubmitButton>Add category</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  )
}
