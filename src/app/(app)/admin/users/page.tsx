import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listUsers, roleCatalog } from "@/lib/admin/users"
import { organizationOptions } from "@/lib/admin/organizations"
import { Badge, EmptyState, PageHeader, Pagination, When, qs } from "@/components/ui"
import { AuthSourceBadge, UserStatusBadge } from "./form"

export const metadata = { title: "Users" }

type SP = Record<string, string | undefined>

export default async function UsersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("admin.users")
  const sp = await searchParams
  const [{ rows, total, page, pageSize }, roles, orgs] = await Promise.all([
    listUsers(actor, { q: sp.q, role: sp.role, status: sp.status, org: sp.org, page: Number(sp.page) || 1 }),
    roleCatalog(actor),
    organizationOptions(actor),
  ])
  const roleName = (key: string) => roles.find((r) => r.key === key)?.name ?? key
  const base: SP = { q: sp.q, role: sp.role, status: sp.status, org: sp.org }
  const tz = actor.tenant.timezone
  return (
    <>
      <PageHeader
        title="Users"
        subtitle={`${total} account${total === 1 ? "" : "s"} in ${actor.tenant.name}`}
        back={{ href: "/admin", label: "Administration" }}
        actions={
          <Link className="btn btn-primary" href="/admin/users/new">
            New user
          </Link>
        }
      />
      <form className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-5" method="get">
        <input name="q" defaultValue={sp.q} placeholder="Name or email…" className="input lg:col-span-2" aria-label="Search" />
        <select name="role" defaultValue={sp.role ?? ""} className="input" aria-label="Role">
          <option value="">Any role</option>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={sp.status ?? ""} className="input" aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="disabled">Disabled</option>
          <option value="locked">Locked out</option>
        </select>
        <div className="flex gap-2">
          <select name="org" defaultValue={sp.org ?? ""} className="input" aria-label="Organisation">
            <option value="">Any organisation</option>
            <option value="none">No organisation</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary">Filter</button>
        </div>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No users match these filters" action={<Link className="btn" href="/admin/users">Clear filters</Link>} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Sign-in</th>
                <th>Two-step</th>
                <th>Last sign-in</th>
                <th>Locked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/admin/users/${u.id}`} className="font-medium">
                      {u.full_name || u.email}
                    </Link>
                    {(u.department || u.organization_name) && (
                      <div className="text-xs text-slate-500">{[u.department, u.organization_name].filter(Boolean).join(" · ")}</div>
                    )}
                    {u.id === actor.id && <div className="text-xs text-slate-400">You</div>}
                  </td>
                  <td className="text-slate-600">{u.email}</td>
                  <td>{u.role === "superadmin" ? <Badge tone="slate">{roleName(u.role)}</Badge> : roleName(u.role)}</td>
                  <td>
                    <UserStatusBadge status={u.status} />
                  </td>
                  <td>
                    <AuthSourceBadge source={u.auth_source} />
                  </td>
                  <td>{u.mfa_enabled ? <Badge tone="green">On</Badge> : <span className="text-xs text-slate-400">Off</span>}</td>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    <When value={u.last_login_at} timeZone={tz} />
                  </td>
                  <td>{u.locked ? <Badge tone="red">Locked</Badge> : <span className="text-xs text-slate-400">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/admin/users${qs(base, { page: p })}`} />
    </>
  )
}
