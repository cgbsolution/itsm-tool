import { requirePermission } from "@/lib/auth/session"
import { assignableRoles } from "@/lib/sysadmin/guard"
import { PageHeader } from "@/components/ui"
import { ProviderForm } from "../provider-form"

export const metadata = { title: "Add sign-in provider" }

export default async function NewProviderPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const actor = await requirePermission("admin.settings")
  const { kind: k } = await searchParams
  const kind = k === "ldap" ? "ldap" : "oidc"
  const roles = await assignableRoles(actor.tenantId)
  return (
    <>
      <PageHeader
        title={kind === "ldap" ? "Add LDAP / Active Directory" : "Add OpenID Connect provider"}
        subtitle={kind === "oidc" ? "After saving, the page shows the redirect URI to register with the identity provider." : "After saving, use Test connection to check the bind."}
        back={{ href: "/admin/auth", label: "Sign-in providers" }}
      />
      <div className="max-w-4xl">
        <ProviderForm kind={kind} provider={null} roles={roles} />
      </div>
    </>
  )
}
