import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { SYSTEM_ROLES } from "@/lib/auth/permissions"
import { listCustomRoles, systemRoleCounts } from "@/lib/admin/roles"
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui"
import { PermissionList } from "./form"

export const metadata = { title: "Roles" }

export default async function RolesPage() {
  const actor = await requirePermission("admin.users")
  const [custom, counts] = await Promise.all([listCustomRoles(actor), systemRoleCounts(actor)])
  return (
    <>
      <PageHeader
        title="Roles"
        subtitle="A role decides what someone may do. Everyone who can sign in may raise and follow their own tickets, use the catalog and read public articles."
        back={{ href: "/admin", label: "Administration" }}
        actions={
          <Link href="/admin/roles/new" className="btn btn-primary">
            New custom role
          </Link>
        }
      />
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Custom roles</h2>
      {custom.length === 0 ? (
        <div className="mb-6">
          <EmptyState title="No custom roles">Create one when the built-in roles do not fit, for example a “Service desk lead” who can assign tickets but not configure the tenant.</EmptyState>
        </div>
      ) : (
        <div className="card mb-6 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Permissions</th>
                <th>People</th>
              </tr>
            </thead>
            <tbody>
              {custom.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/admin/roles/${r.id}`} className="font-medium">
                      {r.name}
                    </Link>
                    {r.description && <div className="text-xs text-slate-500">{r.description}</div>}
                  </td>
                  <td className="font-mono text-xs">{r.key}</td>
                  <td>{r.permissions.length}</td>
                  <td>
                    <Link href={`/admin/users?role=${encodeURIComponent(r.key)}`}>{r.user_count}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Built-in roles (read-only)</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {Object.entries(SYSTEM_ROLES).map(([key, r]) => (
          <Card
            key={key}
            title={
              <span className="flex items-center gap-2">
                {r.name} <span className="font-mono text-xs font-normal text-slate-400">{key}</span>
              </span>
            }
            actions={
              <Link href={`/admin/users?role=${key}`} className="text-xs">
                <Badge>{counts[key] ?? 0} people</Badge>
              </Link>
            }
          >
            <p className="mb-3 text-sm text-slate-500">{r.description}</p>
            {key === "admin" || key === "superadmin" ? (
              <p className="text-sm text-slate-700">
                Every permission{key === "admin" ? " except managing other tenants" : ", in every tenant"}.
              </p>
            ) : (
              <PermissionList permissions={r.permissions} />
            )}
          </Card>
        ))}
      </div>
    </>
  )
}
