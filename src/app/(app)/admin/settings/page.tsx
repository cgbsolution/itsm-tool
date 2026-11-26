import { requirePermission } from "@/lib/auth/session"
import { getGeneralSettings } from "@/lib/sysadmin/settings"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, Field, PageHeader } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { saveSettingsAction } from "./actions"

export const metadata = { title: "Tenant settings" }

export default async function SettingsPage() {
  const actor = await requirePermission("admin.settings")
  const s = await getGeneralSettings(actor)
  return (
    <>
      <PageHeader
        title="Tenant settings"
        subtitle={<>Branding, sign-in policy and email-to-ticket for {actor.tenant.name}{s.updated_at ? ` · last saved ${formatDateTime(s.updated_at, actor.tenant.timezone)}` : ""}</>}
        back={{ href: "/admin", label: "Administration" }}
      />
      <ActionForm action={saveSettingsAction} className="max-w-3xl space-y-4">
        <Card title="Branding">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand name" htmlFor="brand_name" hint={`Shown in the sidebar and in emails. Empty = the tenant name (${actor.tenant.name}).`}>
              <input id="brand_name" name="brand_name" className="input" maxLength={100} defaultValue={s.brand_name ?? ""} />
            </Field>
            <Field label="Brand colour" htmlFor="brand_color" hint="Buttons, links and the email header.">
              <div className="flex items-center gap-2">
                <input id="brand_color" name="brand_color" type="color" className="h-9 w-14 cursor-pointer rounded border border-slate-300 bg-white p-1" defaultValue={s.brand_color} />
                <code className="text-xs text-slate-500">{s.brand_color}</code>
              </div>
            </Field>
            <Field label="Support email" htmlFor="support_email" hint="Where people can write to the service desk." className="sm:col-span-2">
              <input id="support_email" name="support_email" type="email" className="input" maxLength={254} defaultValue={s.support_email ?? ""} placeholder="servicedesk@example.com" />
            </Field>
          </div>
        </Card>

        <Card title="Sign-in policy">
          <div className="space-y-4">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="require_mfa" defaultChecked={s.require_mfa} className="mt-0.5" />
              <span>
                <span className="font-medium">Require two-step sign-in</span>
                <span className="block text-xs text-slate-500">Everyone must set up an authenticator app at their next sign-in (including you, if you have not yet).</span>
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Minimum password length" htmlFor="password_min_length" hint="8 to 128 characters. Applies to new passwords.">
                <input id="password_min_length" name="password_min_length" type="number" min={8} max={128} required className="input" defaultValue={s.password_min_length} />
              </Field>
              <Field label="Session length (hours)" htmlFor="session_hours" hint="1 to 720. People are signed out after this long.">
                <input id="session_hours" name="session_hours" type="number" min={1} max={720} required className="input" defaultValue={s.session_hours} />
              </Field>
            </div>
          </div>
        </Card>

        <Card title="Email-to-ticket">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="inbound_create_users" defaultChecked={s.inbound_create_users} className="mt-0.5" />
            <span>
              <span className="font-medium">Create accounts for unknown senders</span>
              <span className="block text-xs text-slate-500">
                When an email arrives from an address without an account, create a requester account for it. Otherwise the ticket keeps only the sender&apos;s name and address.
              </span>
            </span>
          </label>
        </Card>

        <div>
          <SubmitButton pendingText="Saving…">Save settings</SubmitButton>
        </div>
      </ActionForm>
    </>
  )
}
