import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getGroup, GROUP_KIND_LABELS } from "@/lib/admin/groups"
import { peopleOptions } from "@/lib/admin/users"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, PageHeader, When } from "@/components/ui"
import { GroupFields } from "../form"
import { addMemberAction, deleteGroupAction, removeMemberAction, updateGroupAction } from "../actions"

export const metadata = { title: "Group" }

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.users")
  const { id } = await params
  let data
  try {
    data = await getGroup(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const { group: g, members } = data
  const people = await peopleOptions(actor)
  const candidates = people.filter((p) => !members.some((m) => m.id === p.id))
  const tz = actor.tenant.timezone
  return (
    <>
      <PageHeader
        title={g.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {GROUP_KIND_LABELS[g.kind]}
            {g.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
            <span>
              {g.member_count} member{g.member_count === 1 ? "" : "s"} · {g.open_tickets} open ticket{g.open_tickets === 1 ? "" : "s"}
            </span>
          </span>
        }
        back={{ href: "/admin/groups", label: "Groups" }}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Members">
          {members.length === 0 ? (
            <p className="mb-3 text-sm text-slate-500">No members yet.</p>
          ) : (
            <ul className="mb-3 divide-y divide-slate-100">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <Link href={`/admin/users/${m.id}`} className="font-medium">
                      {m.full_name || m.email}
                    </Link>
                    <div className="truncate text-xs text-slate-500">
                      {m.email}
                      {m.status !== "active" && ` · ${m.status}`} · added <When value={m.added_at} timeZone={tz} />
                    </div>
                  </div>
                  <ActionForm action={removeMemberAction.bind(null, g.id, m.id)} confirm={`Remove ${m.full_name || m.email} from ${g.name}?`}>
                    <SubmitButton className="btn btn-sm btn-ghost">Remove</SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          {candidates.length > 0 && (
            <ActionForm action={addMemberAction.bind(null, g.id)} className="flex gap-2 border-t border-slate-100 pt-3" resetOnSuccess>
              <select name="userId" className="input" required defaultValue="" aria-label="Person to add">
                <option value="" disabled>
                  Add a person…
                </option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email} ({p.email})
                  </option>
                ))}
              </select>
              <SubmitButton className="btn">Add</SubmitButton>
            </ActionForm>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="Details">
            <ActionForm action={updateGroupAction.bind(null, g.id)} className="space-y-3">
              <GroupFields defaults={g} people={people} />
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Delete">
            <p className="mb-3 text-sm text-slate-500">
              A group that open tickets or pending approvals use cannot be deleted: deactivate it instead. Deleting also removes the group&apos;s OLA policies; closed tickets keep
              their history without the group.
            </p>
            <ActionForm action={deleteGroupAction.bind(null, g.id)} confirm={`Delete the group ${g.name}? This cannot be undone.`}>
              <SubmitButton className="btn btn-danger">Delete group</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  )
}
