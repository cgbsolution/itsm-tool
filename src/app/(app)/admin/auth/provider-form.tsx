import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field } from "@/components/ui"
import { formatGroupRoleMap, DEFAULT_OIDC_SCOPES } from "@/lib/sysadmin/validate"
import type { ProviderKind, ProviderView } from "@/lib/sysadmin/auth-providers"
import { saveProviderAction } from "./actions"

type Cfg = Record<string, unknown>

const s = (v: unknown) => (typeof v === "string" ? v : "")
const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : "")

function RoleSelect({ name, roles, value }: { name: string; roles: { key: string; name: string }[]; value: string }) {
  return (
    <select id={name} name={name} className="input" defaultValue={value}>
      {roles.map((r) => (
        <option key={r.key} value={r.key}>
          {r.name} ({r.key})
        </option>
      ))}
    </select>
  )
}

export function ProviderForm({ kind, provider, roles }: { kind: ProviderKind; provider: ProviderView | null; roles: { key: string; name: string }[] }) {
  const c: Cfg = provider?.config ?? {}
  const secretSet = !!provider?.secret_set
  const roleKeys = roles.map((r) => r.key).join(", ")
  return (
    <ActionForm action={saveProviderAction.bind(null, provider?.id ?? null, kind)} className="space-y-4">
      <Card title={kind === "ldap" ? "LDAP / Active Directory" : "OpenID Connect"}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name" required hint="Shown to administrators (for example “Corporate AD”).">
            <input id="name" name="name" required maxLength={100} className="input" defaultValue={provider?.name ?? ""} />
          </Field>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={provider?.enabled ?? false} /> Enabled (people can sign in with it)
            </label>
          </div>

          {kind === "ldap" ? (
            <>
              <Field label="Server URL" htmlFor="url" required hint="ldaps://dc1.corp.local:636, or ldap://…:389 with StartTLS.">
                <input id="url" name="url" required maxLength={500} className="input font-mono" defaultValue={s(c.url)} placeholder="ldaps://dc1.corp.local:636" />
              </Field>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="start_tls" defaultChecked={c.start_tls === true} /> Use StartTLS (with ldap://)
                </label>
              </div>
              <Field label="CA certificate file" htmlFor="ca_file" hint="Optional. Absolute path of a PEM file on this server, for a private certificate authority." className="sm:col-span-2">
                <input id="ca_file" name="ca_file" maxLength={500} className="input font-mono" defaultValue={s(c.ca_file)} placeholder="/etc/itsm/corp-ca.pem" />
              </Field>
              <Field label="Bind DN (service account)" htmlFor="bind_dn" required>
                <input id="bind_dn" name="bind_dn" required maxLength={1000} className="input font-mono" defaultValue={s(c.bind_dn)} placeholder="CN=svc-itsm,OU=Service Accounts,DC=corp,DC=local" />
              </Field>
              <Field label="Bind password" htmlFor="secret" hint={secretSet ? "A password is set. Leave empty to keep it." : "Stored encrypted; never shown again."}>
                <input id="secret" name="secret" type="password" autoComplete="new-password" maxLength={1000} className="input" placeholder={secretSet ? "•••••••• (set)" : ""} />
                {secretSet && (
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-600">
                    <input type="checkbox" name="secret_clear" /> Clear the stored password
                  </label>
                )}
              </Field>
              <Field label="Base DN" htmlFor="base_dn" required hint="Where to look for people.">
                <input id="base_dn" name="base_dn" required maxLength={1000} className="input font-mono" defaultValue={s(c.base_dn)} placeholder="OU=Staff,DC=corp,DC=local" />
              </Field>
              <Field label="User filter" htmlFor="user_filter" hint="Optional. {{email}} and {{username}} are replaced. Empty = mail, userPrincipalName or sAMAccountName.">
                <input id="user_filter" name="user_filter" maxLength={1000} className="input font-mono" defaultValue={s(c.user_filter)} placeholder="(&(objectClass=person)(mail={{email}}))" />
              </Field>
              <Field label="Email attribute" htmlFor="email_attr">
                <input id="email_attr" name="email_attr" maxLength={64} className="input font-mono" defaultValue={s(c.email_attr) || "mail"} />
              </Field>
              <Field label="Name attribute" htmlFor="name_attr">
                <input id="name_attr" name="name_attr" maxLength={64} className="input font-mono" defaultValue={s(c.name_attr) || "displayName"} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Issuer URL" htmlFor="issuer" required hint="The IdP's issuer, exactly as in its /.well-known/openid-configuration." className="sm:col-span-2">
                <input id="issuer" name="issuer" type="url" required maxLength={500} className="input font-mono" defaultValue={s(c.issuer)} placeholder="https://login.example.com/realms/corp" />
              </Field>
              <Field label="Client ID" htmlFor="client_id" required>
                <input id="client_id" name="client_id" required maxLength={255} className="input font-mono" defaultValue={s(c.client_id)} />
              </Field>
              <Field label="Client secret" htmlFor="secret" hint={secretSet ? "A secret is set. Leave empty to keep it." : "Stored encrypted; never shown again."}>
                <input id="secret" name="secret" type="password" autoComplete="new-password" maxLength={1000} className="input" placeholder={secretSet ? "•••••••• (set)" : ""} />
                {secretSet && (
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-600">
                    <input type="checkbox" name="secret_clear" /> Clear the stored secret
                  </label>
                )}
              </Field>
              <Field label="Scopes" htmlFor="scopes" hint='Space-separated; must include "openid".'>
                <input id="scopes" name="scopes" maxLength={500} className="input font-mono" defaultValue={s(c.scopes) || DEFAULT_OIDC_SCOPES} />
              </Field>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="allow_create" defaultChecked={c.allow_create === true} /> Create accounts on first sign-in
                </label>
              </div>
            </>
          )}

          <Field label="Email domains" htmlFor="email_domains" hint={kind === "ldap" ? "Sign-in emails in these domains go to this directory. Empty = every email." : "Optional. Only accept these domains."}>
            <input id="email_domains" name="email_domains" maxLength={2000} className="input" defaultValue={list(c.email_domains)} placeholder="corp.example.com, example.org" />
          </Field>
          <Field label="Default role" htmlFor="default_role" hint="For accounts this provider creates.">
            <RoleSelect name="default_role" roles={roles} value={s(c.default_role) || "user"} />
          </Field>

          {kind === "ldap" && (
            <Field
              label="Group → role mapping"
              htmlFor="group_role_map"
              className="sm:col-span-2"
              hint={<>One per line: <code>group DN = role</code>. The first group a person is in decides the role. Roles: {roleKeys}.</>}
            >
              <textarea
                id="group_role_map"
                name="group_role_map"
                rows={4}
                maxLength={100_000}
                className="input font-mono text-xs"
                defaultValue={formatGroupRoleMap(c.group_role_map as { group_dn: string; role: string }[] | undefined)}
                placeholder={"CN=IT Admins,OU=Groups,DC=corp,DC=local = admin\nCN=Service Desk,OU=Groups,DC=corp,DC=local = engineer"}
              />
            </Field>
          )}
        </div>
      </Card>
      <SubmitButton pendingText="Saving…">{provider ? "Save" : "Add provider"}</SubmitButton>
    </ActionForm>
  )
}
