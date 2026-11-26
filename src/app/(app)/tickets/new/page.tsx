import Link from "next/link"
import { redirect } from "next/navigation"
import { requireActor, can } from "@/lib/auth/session"
import { loadItsmConfig } from "@/lib/itsm/config"
import { assignmentOptions, requesterOptions } from "@/lib/itsm/queries"
import { REQUESTER_TICKET_TYPES, TICKET_TYPE_LABELS, isTicketType, type TicketType } from "@/lib/itsm/vocab"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field, PageHeader } from "@/components/ui"
import { TicketFields } from "../fields"
import { createTicketAction } from "../actions"

export const metadata = { title: "New ticket" }

export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const actor = await requireActor()
  const sp = await searchParams
  const type: TicketType = isTicketType(sp.type) ? sp.type : "incident"
  const staff = can(actor, "ticket.view_all")
  if (!can(actor, "ticket.create")) redirect("/denied")
  if (type === "problem" && !can(actor, "problem.manage")) redirect("/denied")
  if (type === "change" && !can(actor, "change.manage")) redirect("/denied")
  if (!staff && !REQUESTER_TICKET_TYPES.includes(type)) redirect("/denied")

  const [config, options, requesters] = await Promise.all([
    loadItsmConfig(actor.tenantId),
    can(actor, "ticket.work") ? assignmentOptions(actor.tenantId) : Promise.resolve({ people: [], groups: [] }),
    staff ? requesterOptions(actor.tenantId) : Promise.resolve([]),
  ])
  const cabGroups = options.groups.filter((g) => g.kind === "cab")

  return (
    <>
      <PageHeader
        title={`New ${TICKET_TYPE_LABELS[type].toLowerCase()}`}
        back={{ href: "/tickets", label: "Tickets" }}
        subtitle={
          type === "service_request" ? (
            <>
              Tip: the <Link href="/catalog">service catalog</Link> has ready-made request forms with approvals.
            </>
          ) : undefined
        }
      />
      <ActionForm action={createTicketAction} className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <input type="hidden" name="type" value={type} />
        <Card>
          <TicketFields type={type} config={config} staff={staff} cabGroups={cabGroups} timeZone={actor.tenant.timezone} />
        </Card>
        <div className="space-y-4">
          {staff && (
            <Card title="Requester">
              <Field label="Raised for" htmlFor="requesterId" hint="Leave empty to raise it for yourself.">
                <select id="requesterId" name="requesterId" className="input" defaultValue="">
                  <option value="">Me ({actor.name})</option>
                  {requesters
                    .filter((r) => r.id !== actor.id)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.full_name || r.email} · {r.email}
                      </option>
                    ))}
                </select>
              </Field>
            </Card>
          )}
          {can(actor, "ticket.work") && (
            <Card title="Assignment">
              <div className="space-y-3">
                <Field label="Group" htmlFor="assignmentGroupId">
                  <select id="assignmentGroupId" name="assignmentGroupId" className="input" defaultValue="">
                    <option value="">— Unassigned queue —</option>
                    {options.groups
                      .filter((g) => g.kind === "support" || g.kind === "other")
                      .map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                  </select>
                </Field>
                <Field label="Assignee" htmlFor="assigneeId">
                  <select id="assigneeId" name="assigneeId" className="input" defaultValue="">
                    <option value="">— Nobody yet —</option>
                    {options.people
                      .filter((p) => can(actor, "ticket.assign") || p.id === actor.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
                      ))}
                  </select>
                </Field>
              </div>
            </Card>
          )}
          {can(actor, "cmdb.view") && (
            <Card title="Configuration items">
              <Field label="CI codes" htmlFor="ciCodes" hint="Comma-separated, e.g. LAP-0042, SRV-DB01">
                <input id="ciCodes" name="ciCodes" className="input" />
              </Field>
            </Card>
          )}
          <Card title="Attachments">
            <input type="file" name="files" multiple className="block w-full text-sm" />
            <p className="hint">Up to 10 files, 25 MB each. Programs and scripts are not accepted.</p>
          </Card>
          <SubmitButton className="btn btn-primary w-full" pendingText="Creating…">
            Create {TICKET_TYPE_LABELS[type].toLowerCase()}
          </SubmitButton>
        </div>
      </ActionForm>
    </>
  )
}
