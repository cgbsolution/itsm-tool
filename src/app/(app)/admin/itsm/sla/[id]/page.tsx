import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getSlaPolicy } from "@/lib/admin/sla"
import { groupOptions } from "@/lib/admin/groups"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../../tabs"
import { Note } from "../../parts"
import { SlaFields } from "../form"
import { deleteSlaAction, updateSlaAction } from "../../actions"

export const metadata = { title: "Edit policy" }

export default async function SlaPolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.itsm")
  const { id } = await params
  let p
  try {
    p = await getSlaPolicy(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const groups = await groupOptions(actor)
  return (
    <>
      <PageHeader title={`Edit ${p.kind.toUpperCase()} policy`} subtitle={p.kind === "ola" ? p.group_name ?? undefined : undefined} back={{ href: "/admin/itsm/sla", label: "SLA & OLA" }} />
      <ItsmTabs active="sla" />
      <Note>Changes apply to clocks that start after you save. Running clocks keep their targets.</Note>
      <Card className="max-w-5xl">
        <ActionForm action={updateSlaAction.bind(null, p.id)} className="space-y-3">
          <SlaFields kind={p.kind} policy={p} groups={groups} />
          <SubmitButton>Save policy</SubmitButton>
        </ActionForm>
      </Card>
      <Card title="Delete" className="mt-4 max-w-5xl">
        <p className="mb-3 text-sm text-slate-500">
          Tickets that already use this policy keep their deadlines. New tickets of this record type and priority fall back to the “All types” policy, if there is one.
          Deactivating keeps the policy for later.
        </p>
        <ActionForm action={deleteSlaAction.bind(null, p.id)} confirm="Delete this policy?">
          <SubmitButton className="btn btn-danger">Delete policy</SubmitButton>
        </ActionForm>
      </Card>
    </>
  )
}
