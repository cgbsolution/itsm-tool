import Link from "next/link"
import { requireAnyPermission, can } from "@/lib/auth/session"
import type { Permission } from "@/lib/auth/permissions"
import { PageHeader } from "@/components/ui"

export const metadata = { title: "Administration" }

type Section = { href: string; title: string; description: string; perm: Permission; superadminOnly?: boolean }

const GROUPS: { title: string; items: Section[] }[] = [
  {
    title: "People",
    items: [
      { href: "/admin/users", title: "Users", description: "Accounts, roles, invitations, password resets, two-step sign-in and lockouts", perm: "admin.users" },
      { href: "/admin/groups", title: "Groups", description: "Support groups, the Change Advisory Board and approver groups, with their members", perm: "admin.users" },
      { href: "/admin/roles", title: "Roles", description: "Built-in roles and custom roles with their own permissions", perm: "admin.users" },
      { href: "/admin/organizations", title: "Organisations", description: "Client companies that people and tickets belong to", perm: "admin.users" },
    ],
  },
  {
    title: "Service management",
    items: [
      { href: "/admin/itsm/categories", title: "Categories", description: "The category and sub-category tree offered on tickets", perm: "admin.itsm" },
      { href: "/admin/itsm/priority", title: "Priority matrix", description: "How impact and urgency set the priority", perm: "admin.itsm" },
      { href: "/admin/itsm/sla", title: "SLA & OLA policies", description: "Response and resolution targets per record type and priority", perm: "admin.itsm" },
      { href: "/admin/itsm/calendar", title: "Working calendar", description: "Time zone, working hours, holidays and ticket behaviour", perm: "admin.itsm" },
      { href: "/admin/itsm/fields", title: "Custom fields", description: "Extra fields on incidents, requests, problems and changes", perm: "admin.itsm" },
      { href: "/admin/itsm/templates", title: "Email templates", description: "The wording of the emails people receive", perm: "admin.itsm" },
      { href: "/admin/itsm/windows", title: "Maintenance windows", description: "Maintenance windows and change freezes", perm: "admin.itsm" },
    ],
  },
  {
    title: "Tenant",
    items: [
      { href: "/admin/settings", title: "Settings", description: "Branding, support address and sign-in policy", perm: "admin.settings" },
      { href: "/admin/email", title: "Email", description: "Outgoing SMTP and incoming mailbox for email-to-ticket", perm: "admin.settings" },
      { href: "/admin/auth", title: "Sign-in providers", description: "LDAP / Active Directory and single sign-on (OIDC)", perm: "admin.settings" },
      { href: "/admin/api-tokens", title: "API tokens", description: "Personal access tokens for integrations", perm: "admin.settings" },
    ],
  },
  {
    title: "Instance",
    items: [
      { href: "/admin/tenants", title: "Tenants", description: "Create, suspend and switch between tenants", perm: "admin.tenants", superadminOnly: true },
      { href: "/admin/license", title: "Licence", description: "Install and check the licence", perm: "admin.license" },
      { href: "/admin/system", title: "System", description: "Health, background jobs and version", perm: "admin.settings" },
    ],
  },
]

const ADMIN_PERMS: Permission[] = ["admin.users", "admin.itsm", "admin.settings", "admin.license", "admin.tenants"]

export default async function AdminPage() {
  const actor = await requireAnyPermission(ADMIN_PERMS)
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((s) => can(actor, s.perm) && (!s.superadminOnly || actor.isSuperadmin)),
  })).filter((g) => g.items.length > 0)
  return (
    <>
      <PageHeader
        title="Administration"
        subtitle={actor.isSuperadmin && actor.tenantId !== actor.homeTenantId ? `Changes apply to ${actor.tenant.name}` : actor.tenant.name}
      />
      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.title}>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{g.title}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {g.items.map((s) => (
                <Link key={s.href} href={s.href} className="block text-inherit no-underline hover:no-underline">
                  <div className="card card-body h-full transition-colors hover:border-slate-300">
                    <div className="font-medium text-slate-900">{s.title}</div>
                    <p className="mt-1 text-sm text-slate-500">{s.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
