import { requirePermission } from "@/lib/auth/session"
import { listTokens, tokenUserOptions } from "@/lib/sysadmin/api-tokens"
import { config } from "@/lib/config"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, PageHeader, When } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { CreateTokenForm } from "./create-token-form"
import { revokeTokenAction } from "./actions"

export const metadata = { title: "API tokens" }

export default async function ApiTokensPage() {
  const actor = await requirePermission("admin.settings")
  const [tokens, users] = await Promise.all([listTokens(actor), tokenUserOptions(actor)])
  const tz = actor.tenant.timezone
  const now = Date.now()
  const selfId = users.some((u) => u.id === actor.id) ? actor.id : null
  return (
    <>
      <PageHeader title="API tokens" subtitle="Personal access tokens for integrations: HR sync, monitoring, scripts" back={{ href: "/admin", label: "Administration" }} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Create a token" className="xl:col-span-2">
          <CreateTokenForm users={users.map((u) => ({ id: u.id, label: u.full_name ? `${u.full_name} <${u.email}>` : u.email }))} selfId={selfId} />
          {!selfId && <p className="hint mt-2">You are working in another tenant, so a token can only act as one of its users.</p>}
        </Card>
        <Card title="Using a token">
          <div className="space-y-2 text-sm text-slate-600">
            <p>Send the token in the Authorization header. It has exactly the permissions of the user it acts as.</p>
            <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{`curl -H "Authorization: Bearer itsm_pat_…" \\\n  ${config.appUrl()}/api/…`}</pre>
            <p>Revoke tokens you no longer use. Only a fingerprint of each token is stored, so a lost token cannot be shown again: create a new one.</p>
          </div>
        </Card>
      </div>

      <h2 className="mt-8 mb-3">Tokens</h2>
      {tokens.length === 0 ? (
        <EmptyState title="No API tokens yet" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Acts as</th>
                <th>Prefix</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const expired = !!t.expires_at && new Date(t.expires_at).getTime() < now
                return (
                  <tr key={t.id}>
                    <td className="font-medium">{t.name}</td>
                    <td className="text-sm">
                      {t.user_name}
                      <div className="text-xs text-slate-400">{t.user_email}</div>
                    </td>
                    <td className="font-mono text-xs">{t.prefix}…</td>
                    <td className="text-xs whitespace-nowrap text-slate-500">{formatDateTime(t.created_at, tz)}</td>
                    <td className="text-xs whitespace-nowrap text-slate-500">{t.last_used_at ? <When value={t.last_used_at} timeZone={tz} /> : "Never"}</td>
                    <td className="text-xs whitespace-nowrap text-slate-500">{t.expires_at ? formatDateTime(t.expires_at, tz) : "Never"}</td>
                    <td>
                      {t.revoked_at ? (
                        <Badge tone="red" title={formatDateTime(t.revoked_at, tz)}>Revoked</Badge>
                      ) : expired ? (
                        <Badge tone="amber">Expired</Badge>
                      ) : (
                        <Badge tone="green">Active</Badge>
                      )}
                    </td>
                    <td>
                      {!t.revoked_at && (
                        <ActionForm action={revokeTokenAction.bind(null, t.id)} confirm={`Revoke the token "${t.name}"? Integrations using it stop working at once.`}>
                          <SubmitButton className="btn btn-sm btn-danger">Revoke</SubmitButton>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
