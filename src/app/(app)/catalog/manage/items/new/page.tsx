import { requirePermission } from "@/lib/auth/session"
import { itemFormOptions } from "@/lib/catalog/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { createItemAction } from "../../actions"
import { ItemFields } from "../../item-form"

export const metadata = { title: "New catalog item" }

export default async function NewCatalogItemPage() {
  const actor = await requirePermission("catalog.manage")
  const options = await itemFormOptions(actor)
  return (
    <>
      <PageHeader title="New catalog item" subtitle="After saving you can build its request form and fulfilment tasks." back={{ href: "/catalog/manage", label: "Manage catalog" }} />
      <ActionForm action={createItemAction}>
        <Card>
          <ItemFields options={options} />
          <div className="mt-4 flex justify-end border-t border-slate-100 pt-4">
            <SubmitButton pendingText="Creating…">Create item</SubmitButton>
          </div>
        </Card>
      </ActionForm>
    </>
  )
}
