/** Catalog item details form fields (server component), shared by the new and edit pages. */
import { Field } from "@/components/ui"
import { PRIORITIES, PRIORITY_LABELS } from "@/lib/itsm/vocab"
import type { CatalogItemRow } from "@/lib/catalog/service"
import type { itemFormOptions } from "@/lib/catalog/queries"
import { MarkdownEditor } from "../../kb/client"

type Options = Awaited<ReturnType<typeof itemFormOptions>>

export function ItemFields({ item, options }: { item?: CatalogItemRow; options: Options }) {
  const approverGroups = options.groups.filter((g) => g.kind === "approvers" || g.kind === "cab" || g.id === item?.approver_group_id)
  const otherGroups = options.groups.filter((g) => !approverGroups.includes(g))
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
          <Field label="Name" htmlFor="name" required>
            <input id="name" name="name" className="input" required minLength={2} maxLength={200} defaultValue={item?.name ?? ""} placeholder="New laptop" />
          </Field>
          <Field label="Category" htmlFor="categoryId">
            <select id="categoryId" name="categoryId" className="input" defaultValue={item?.category_id ?? ""}>
              <option value="">— None —</option>
              {options.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Short description" htmlFor="shortDescription" hint="Shown on the catalog card.">
          <input id="shortDescription" name="shortDescription" className="input" maxLength={300} defaultValue={item?.short_description ?? ""} />
        </Field>
        <Field label="Description" htmlFor="description" hint="Shown above the request form. Markdown is supported.">
          <MarkdownEditor id="description" name="description" rows={7} defaultValue={item?.description ?? ""} />
        </Field>
      </div>

      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" name="isActive" defaultChecked={item?.is_active ?? true} /> Active (shown in the catalog)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Who can see it" htmlFor="visibility">
            <select id="visibility" name="visibility" className="input" defaultValue={item?.visibility ?? "all"}>
              <option value="all">Everyone</option>
              <option value="staff">IT staff only</option>
            </select>
          </Field>
          <Field label="Sort order" htmlFor="sortOrder">
            <input id="sortOrder" name="sortOrder" type="number" className="input" defaultValue={item?.sort_order ?? 0} />
          </Field>
        </div>
        <Field label="Default priority" htmlFor="defaultPriority">
          <select id="defaultPriority" name="defaultPriority" className="input" defaultValue={item?.default_priority ?? "medium"}>
            {[...PRIORITIES].reverse().map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ticket category" htmlFor="ticketCategoryId" hint="Set on the request ticket (for reports and SLAs).">
          <select id="ticketCategoryId" name="ticketCategoryId" className="input" defaultValue={item?.ticket_category_id ?? ""}>
            <option value="">— None —</option>
            {options.ticketCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fulfilment group" htmlFor="fulfilmentGroupId" hint="The request is routed to this group.">
          <select id="fulfilmentGroupId" name="fulfilmentGroupId" className="input" defaultValue={item?.fulfilment_group_id ?? ""}>
            <option value="">— IT team queue —</option>
            {options.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold text-slate-800">Approval</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="requiresApproval" defaultChecked={item?.requires_approval ?? false} /> Requires approval
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="approveByManager" defaultChecked={item?.approve_by_manager ?? false} className="mt-0.5" />
            <span>
              Requester&apos;s manager approves first
              <span className="block text-xs text-slate-500">Skipped when the requester has no manager.</span>
            </span>
          </label>
          <Field label="Approver group" htmlFor="approverGroupId">
            <select id="approverGroupId" name="approverGroupId" className="input" defaultValue={item?.approver_group_id ?? ""}>
              <option value="">— None —</option>
              {approverGroups.length > 0 && (
                <optgroup label="Approver groups">
                  {approverGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {otherGroups.length > 0 && (
                <optgroup label="Other groups">
                  {otherGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          <Field label="The group decides when" htmlFor="approvalMode">
            <select id="approvalMode" name="approvalMode" className="input" defaultValue={item?.approval_mode ?? "any"}>
              <option value="any">Any one member approves</option>
              <option value="all">Every member approves</option>
            </select>
          </Field>
          <p className="hint">Nobody approves their own request. Without anyone who can approve, the request goes straight to fulfilment with a note.</p>
        </fieldset>
      </div>
    </div>
  )
}
