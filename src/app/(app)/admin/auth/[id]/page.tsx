import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { getProvider, oidcRedirectUri, type ProviderView } from "@/lib/sysadmin/auth-providers"
import { assignableRoles } from "@/lib/sysadmin/guard"
import { AppError } from "@/lib/errors"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { ProviderForm } from "../provider-form"
import { deleteProviderAction, testLdapAction } from "../actions"

export const metadata = { title: "Sign-in provider" }

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.settings")
  const { id } = await params
  let provider: ProviderView
  try {
    provider = await getProvider(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const roles = await assignableRoles(actor.tenantId)
  return (
    <>
      <PageHeader title={provider.name} subtitle={provider.kind === "ldap" ? "LDAP / Active Directory" : "OpenID Connect"} back={{ href: "/admin/auth", label: "Sign-in providers" }} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ProviderForm kind={provider.kind} provider={provider} roles={roles} />
        </div>
        <div className="space-y-4">
          {provider.kind === "oidc" ? (
            <Card title="Redirect URI">
              <p className="mb-2 text-sm text-slate-600">Register this sign-in redirect (callback) URI with the identity provider:</p>
              <input readOnly className="input font-mono text-xs" value={oidcRedirectUri(provider.id)} aria-label="Redirect URI" />
            </Card>
          ) : (
            <Card title="Test connection">
              <p className="mb-2 text-sm text-slate-600">Binds with the saved service account and reads the base DN. Save changes first.</p>
              <ActionForm action={testLdapAction.bind(null, provider.id)}>
                <SubmitButton className="btn" pendingText="Testing…">
                  Test connection
                </SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Card title="Remove">
            <p className="mb-2 text-sm text-slate-600">People who signed in with this provider keep their accounts but can no longer sign in this way.</p>
            <ActionForm action={deleteProviderAction.bind(null, provider.id)} confirm={`Remove the sign-in provider "${provider.name}"?`}>
              <SubmitButton className="btn btn-danger">Remove provider</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  )
}
