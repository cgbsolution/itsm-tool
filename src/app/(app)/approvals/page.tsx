import Link from "next/link"
import { revalidatePath } from "next/cache"
import { requireActor } from "@/lib/auth/session"
import { decideApproval, myPendingApprovals } from "@/lib/itsm/approvals"
import { fail, ok, type FormState } from "@/lib/actions"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, EmptyState, PageHeader, PriorityBadge, TypeBadge, When } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { humanize } from "@/lib/itsm/vocab"

export const metadata = { title: "Approvals" }

async function decide(approvalId: string, _: FormState, fd: FormData): Promise<FormState> {
  "use server"
  const actor = await requireActor()
  try {
    const approve = fd.get("decision") === "approve"
    await decideApproval(actor, approvalId, approve, String(fd.get("comment") ?? "") || null)
    revalidatePath("/approvals")
    return ok(approve ? "Approved" : "Rejected")
  } catch (e) {
    return fail(e)
  }
}

export default async function ApprovalsPage() {
  const actor = await requireActor()
  const items = await myPendingApprovals(actor)
  const tz = actor.tenant.timezone
  return (
    <>
      <PageHeader title="Approvals" subtitle="Changes and requests waiting for your decision" />
      {items.length === 0 ? (
        <EmptyState title="Nothing waiting for you">When a change or request needs your approval it appears here and you get an email.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a.id} className="card card-body">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/tickets/${a.number}`} className="font-mono text-sm font-medium">{a.number}</Link>
                    <TypeBadge type={a.ticket_type} />
                    <PriorityBadge priority={a.priority} />
                    {a.change_type && <Badge tone="blue">{humanize(a.change_type)}</Badge>}
                    {a.risk && <Badge tone={a.risk === "high" ? "red" : a.risk === "medium" ? "amber" : "gray"}>Risk: {a.risk}</Badge>}
                  </div>
                  <div className="mt-1 font-medium">{a.subject}</div>
                  <div className="text-xs text-slate-500">
                    Requested by {a.requested_by_name ?? "—"} <When value={a.requested_at} timeZone={tz} />
                    {a.group_name ? ` · as a member of ${a.group_name}` : ""} · step {a.step}
                    {a.planned_start && ` · planned ${formatDateTime(a.planned_start, tz)} → ${formatDateTime(a.planned_end, tz)}`}
                  </div>
                </div>
                <ActionForm action={decide.bind(null, a.id)} className="flex w-full max-w-md flex-col gap-2 sm:w-auto">
                  <input name="comment" className="input" placeholder="Comment (required to reject)" />
                  <div className="flex gap-2">
                    <SubmitButton name="decision" value="approve" className="btn btn-primary flex-1">Approve</SubmitButton>
                    <SubmitButton name="decision" value="reject" className="btn btn-danger flex-1">Reject</SubmitButton>
                  </div>
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
