import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listGroups, GROUP_KIND_LABELS } from "@/lib/admin/groups"
import { peopleOptions } from "@/lib/admin/users"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui"
import { GroupFields } from "./form"
import { createGroupAction } from "./actions"

export const metadata = { title: "Groups" }

export default async function GroupsPage() {
  const actor = await requirePermission("admin.users")
  const [groups, people] = await Promise.all([listGroups(actor), peopleOptions(actor)])
  return (
    <>
      <PageHeader title="Groups" subtitle="Support groups receive tickets; CAB and approver groups decide approvals" back={{ href: "/admin", label: "Administration" }} />
      {groups.length === 0 ? (
        <EmptyState title="No groups yet">Create the first group below.</EmptyState>
      ) : (
        <div className="card mb-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Used for</th>
                <th>Manager</th>
                <th>Members</th>
                <th>Open tickets</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link href={`/admin/groups/${g.id}`} className="font-medium">
                      {g.name}
                    </Link>
                    {g.description && <div className="text-xs text-slate-500">{g.description}</div>}
                  </td>
                  <td className="text-slate-600">{GROUP_KIND_LABELS[g.kind]}</td>
                  <td className="text-slate-600">{g.manager_name ?? "—"}</td>
                  <td>{g.member_count}</td>
                  <td>{g.open_tickets}</td>
                  <td>{g.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Card title="New group" className="max-w-3xl">
        <ActionForm action={createGroupAction} className="space-y-3">
          <GroupFields people={people} />
          <SubmitButton>Create group</SubmitButton>
        </ActionForm>
      </Card>
    </>
  )
}
