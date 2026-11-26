import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listProviders } from "@/lib/sysadmin/auth-providers"
import { Badge, EmptyState, PageHeader, When } from "@/components/ui"

export const metadata = { title: "Sign-in providers" }

export default async function AuthProvidersPage() {
  const actor = await requirePermission("admin.settings")
  const providers = await listProviders(actor)
  const tz = actor.tenant.timezone
  return (
    <>
      <PageHeader
        title="Sign-in providers"
        subtitle="LDAP / Active Directory and OpenID Connect (Entra ID, Keycloak, Okta…). Local passwords keep working alongside them."
        back={{ href: "/admin", label: "Administration" }}
        actions={
          <>
            <Link className="btn" href="/admin/auth/new?kind=ldap">
              Add LDAP / AD
            </Link>
            <Link className="btn btn-primary" href="/admin/auth/new?kind=oidc">
              Add OIDC
            </Link>
          </>
        }
      />
      {providers.length === 0 ? (
        <EmptyState title="No sign-in providers">People sign in with a password set by invitation. Add a directory or an identity provider for single sign-on.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Server / issuer</th>
                <th>Status</th>
                <th>Secret</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/admin/auth/${p.id}`} className="font-medium">
                      {p.name}
                    </Link>
                  </td>
                  <td>
                    <Badge tone="slate">{p.kind === "ldap" ? "LDAP / AD" : "OIDC"}</Badge>
                  </td>
                  <td className="font-mono text-xs text-slate-600">{String((p.kind === "ldap" ? p.config.url : p.config.issuer) ?? "—")}</td>
                  <td>{p.enabled ? <Badge tone="green">Enabled</Badge> : <Badge>Off</Badge>}</td>
                  <td className="text-xs text-slate-500">{p.secret_set ? "Set" : "Not set"}</td>
                  <td className="text-xs text-slate-500">
                    <When value={p.updated_at} timeZone={tz} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
