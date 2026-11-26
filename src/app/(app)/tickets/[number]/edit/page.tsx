import { notFound, redirect } from "next/navigation"
import { requireActor, can } from "@/lib/auth/session"
import { getTicketDetail, assignmentOptions } from "@/lib/itsm/queries"
import { AppError } from "@/lib/errors"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { TicketFields } from "../../fields"
import { updateTicketAction } from "../../actions"

export const metadata = { title: "Edit ticket" }

export default async function EditTicketPage({ params }: { params: Promise<{ number: string }> }) {
  const actor = await requireActor()
  const { number } = await params
  let d
  try {
    d = await getTicketDetail(actor, decodeURIComponent(number))
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const t = d.ticket
  if (!d.access.canWork) redirect(`/tickets/${t.number}?error=${encodeURIComponent("Only the assignee or an administrator can edit this ticket")}`)
  const groups = t.ticket_type === "change" ? (await assignmentOptions(actor.tenantId)).groups.filter((g) => g.kind === "cab") : []
  return (
    <>
      <PageHeader title={`Edit ${t.number}`} back={{ href: `/tickets/${t.number}`, label: t.number }} />
      <ActionForm action={updateTicketAction.bind(null, t.id, t.number, t.version)} className="max-w-3xl space-y-4">
        <Card>
          <TicketFields
            type={t.ticket_type}
            config={d.config}
            staff={can(actor, "ticket.view_all")}
            defaults={t}
            cabGroups={groups}
            timeZone={actor.tenant.timezone}
            editing
          />
        </Card>
        <SubmitButton>Save changes</SubmitButton>
      </ActionForm>
    </>
  )
}
