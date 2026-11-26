import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listDeviceGroups } from "@/lib/endpoints/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { createGroupAction, deleteGroupAction, updateGroupAction } from "../actions"

export const metadata = { title: "Device groups" }

export default async function GroupsPage() {
  const actor = await requirePermission("endpoint.manage")
  const groups = await listDeviceGroups(actor.tenantId)

  return (
    <>
      <PageHeader
        back={{ href: "/endpoints", label: "Devices" }}
        title="Device groups"
        subtitle="Groups are deployment rings: ring 0 (pilot) gets patches first, higher rings later."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title={`Groups (${groups.length})`} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-16">Ring</th>
                  <th>Name and description</th>
                  <th className="w-20">Devices</th>
                  <th className="w-28"></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id}>
                    <td colSpan={4} className="p-0">
                      <ActionForm action={updateGroupAction.bind(null, g.id)} className="grid grid-cols-[4rem_1fr_5rem_7rem] items-start gap-2 px-3 py-2">
                        <input name="ring" type="number" min={0} max={9} defaultValue={g.ring} className="input" aria-label="Ring" />
                        <div className="space-y-1">
                          <input name="name" defaultValue={g.name} required maxLength={100} className="input font-medium" aria-label="Name" />
                          <input name="description" defaultValue={g.description ?? ""} maxLength={1000} className="input text-xs" placeholder="Description" aria-label="Description" />
                          {g.policies > 0 && <p className="hint">{g.policies} patch polic{g.policies === 1 ? "y" : "ies"} target this group.</p>}
                        </div>
                        <Link href={`/endpoints?group=${g.id}`} className="pt-1.5 text-sm">{g.devices}</Link>
                        <SubmitButton className="btn btn-sm">Save</SubmitButton>
                      </ActionForm>
                      <div className="flex justify-end px-3 pb-2">
                        <ActionForm
                          action={deleteGroupAction.bind(null, g.id)}
                          confirm={`Delete ${g.name}?${g.policies ? ` Its ${g.policies} patch polic${g.policies === 1 ? "y is" : "ies are"} deleted too.` : ""}`}
                        >
                          <button className="text-xs text-slate-400 hover:text-red-600" disabled={g.devices > 0} title={g.devices > 0 ? "Move its devices out first" : "Delete group"}>
                            Delete
                          </button>
                        </ActionForm>
                      </div>
                    </td>
                  </tr>
                ))}
                {groups.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-sm text-slate-500">No groups yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="New group">
          <ActionForm action={createGroupAction} resetOnSuccess className="space-y-3">
            <div>
              <label className="label" htmlFor="gname">Name</label>
              <input id="gname" name="name" required maxLength={100} className="input" placeholder="e.g. Servers" />
            </div>
            <div>
              <label className="label" htmlFor="gdesc">Description</label>
              <input id="gdesc" name="description" maxLength={1000} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="gring">Ring</label>
              <input id="gring" name="ring" type="number" min={0} max={9} defaultValue={1} className="input" />
              <p className="hint">0 = pilot. Deploy to lower rings first.</p>
            </div>
            <SubmitButton>Create group</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  )
}
