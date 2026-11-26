import { redirect } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { listTenants } from "@/lib/sysadmin/tenants"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, Field, PageHeader } from "@/components/ui"
import { formatDate } from "@/lib/format"
import { createTenantAction, setTenantStatusAction, switchBackAction, switchTenantAction } from "./actions"

export const metadata = { title: "Tenants" }

export default async function TenantsPage() {
  const actor = await requirePermission("admin.tenants")
  if (!actor.isSuperadmin) redirect("/denied")
  const tenants = await listTenants(actor)
  const tz = actor.tenant.timezone
  const switched = actor.tenantId !== actor.homeTenantId
  return (
    <>
      <PageHeader title="Tenants" subtitle="Separate organisations on this installation. Super administrators only." back={{ href: "/admin", label: "Administration" }} />

      {switched && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <span>
            You are working in <strong>{actor.tenant.name}</strong>. Everything you see and change applies to that tenant.
          </span>
          <ActionForm action={switchBackAction}>
            <SubmitButton className="btn btn-sm">Back to my tenant</SubmitButton>
          </ActionForm>
        </div>
      )}

      <div className="card mb-6 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Status</th>
              <th className="text-right">Users</th>
              <th className="text-right">Tickets</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => {
              const current = t.id === actor.tenantId
              const home = t.id === actor.homeTenantId
              return (
                <tr key={t.id}>
                  <td className="font-medium">
                    {t.name}
                    {home && <span className="ml-2 text-xs text-slate-400">(your tenant)</span>}
                    {current && !home && <span className="ml-2 text-xs text-amber-700">(working here)</span>}
                  </td>
                  <td className="font-mono text-xs">{t.slug}</td>
                  <td>{t.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Suspended</Badge>}</td>
                  <td className="text-right tabular-nums">{t.users}</td>
                  <td className="text-right tabular-nums">{t.tickets}</td>
                  <td className="text-xs whitespace-nowrap text-slate-500">{formatDate(t.created_at, tz)}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-2">
                      {!current && (
                        <ActionForm action={switchTenantAction.bind(null, t.id)}>
                          <SubmitButton className="btn btn-sm">{home ? "Back to my tenant" : "Switch to"}</SubmitButton>
                        </ActionForm>
                      )}
                      {!home &&
                        (t.status === "active" ? (
                          <ActionForm action={setTenantStatusAction.bind(null, t.id, "suspended")} confirm={`Suspend ${t.name}?`}>
                            <SubmitButton className="btn btn-sm btn-danger">Suspend</SubmitButton>
                          </ActionForm>
                        ) : (
                          <ActionForm action={setTenantStatusAction.bind(null, t.id, "active")}>
                            <SubmitButton className="btn btn-sm">Activate</SubmitButton>
                          </ActionForm>
                        ))}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Card title="Create a tenant" className="max-w-3xl">
        <ActionForm action={createTenantAction} className="grid gap-4 sm:grid-cols-2" resetOnSuccess>
          <Field label="Name" htmlFor="name" required>
            <input id="name" name="name" required maxLength={200} className="input" placeholder="Acme Ltd" />
          </Field>
          <Field label="Slug" htmlFor="slug" hint="Lowercase letters, digits and hyphens. Empty = from the name.">
            <input id="slug" name="slug" maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,62}" className="input font-mono" placeholder="acme" />
          </Field>
          <Field label="Time zone" htmlFor="timezone" hint="IANA name, e.g. Asia/Kolkata, Europe/London. Used for SLAs and dates.">
            <input id="timezone" name="timezone" maxLength={100} className="input" defaultValue={tz} />
          </Field>
          <div />
          <Field label="First administrator's email" htmlFor="adminEmail" required>
            <input id="adminEmail" name="adminEmail" type="email" required maxLength={254} className="input" />
          </Field>
          <Field label="First administrator's name" htmlFor="adminName" required>
            <input id="adminName" name="adminName" required maxLength={200} className="input" />
          </Field>
          <p className="hint sm:col-span-2">
            The tenant gets the default categories, priority matrix, SLAs and groups. The administrator receives an email invitation (valid 72 hours) to set a password.
          </p>
          <div className="sm:col-span-2">
            <SubmitButton pendingText="Creating…">Create tenant</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </>
  )
}
