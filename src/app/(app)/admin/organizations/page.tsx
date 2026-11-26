import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listOrganizations } from "@/lib/admin/organizations"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, Field, PageHeader } from "@/components/ui"
import { createOrganizationAction } from "./actions"

export const metadata = { title: "Organisations" }

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const actor = await requirePermission("admin.users")
  const sp = await searchParams
  const orgs = await listOrganizations(actor, { q: sp.q })
  return (
    <>
      <PageHeader
        title="Organisations"
        subtitle="Client companies inside this tenant. A label on people, tickets and CIs, not an access boundary."
        back={{ href: "/admin", label: "Administration" }}
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div>
          <form method="get" className="card mb-4 flex gap-2 p-3">
            <input name="q" defaultValue={sp.q} placeholder="Name or domain…" className="input" aria-label="Search" />
            <button className="btn btn-primary">Search</button>
          </form>
          {orgs.length === 0 ? (
            <EmptyState title={sp.q ? "No organisations match" : "No organisations yet"}>{sp.q ? undefined : "Add the first one with the form."}</EmptyState>
          ) : (
            <div className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Domain</th>
                    <th>People</th>
                    <th>Tickets</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orgs.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <Link href={`/admin/organizations/${o.id}`} className="font-medium">
                          {o.name}
                        </Link>
                      </td>
                      <td className="text-slate-600">{o.domain ?? "—"}</td>
                      <td>
                        <Link href={`/admin/users?org=${o.id}`}>{o.user_count}</Link>
                      </td>
                      <td>{o.ticket_count}</td>
                      <td>{o.status === "active" ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <Card title="Add organisation">
          <ActionForm action={createOrganizationAction} className="space-y-3" resetOnSuccess>
            <Field label="Name" htmlFor="name" required>
              <input id="name" name="name" className="input" required maxLength={200} />
            </Field>
            <Field label="Email domain" htmlFor="domain" hint="For example example.com">
              <input id="domain" name="domain" className="input" maxLength={253} />
            </Field>
            <Field label="Status" htmlFor="status">
              <select id="status" name="status" className="input" defaultValue="active">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
            <SubmitButton>Add</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  )
}
