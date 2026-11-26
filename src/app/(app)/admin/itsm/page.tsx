import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { itsmOverview } from "@/lib/admin/itsm"
import { loadTenantSettings } from "@/lib/itsm/config"
import { listTemplatesAdmin } from "@/lib/admin/templates"
import { PageHeader } from "@/components/ui"
import { ItsmTabs } from "./tabs"

export const metadata = { title: "ITSM settings" }

export default async function ItsmIndexPage() {
  const actor = await requirePermission("admin.itsm")
  const [counts, settings, templates] = await Promise.all([
    itsmOverview(actor),
    loadTenantSettings(actor.tenantId),
    listTemplatesAdmin(actor),
  ])
  const c = counts
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const cards = [
    { href: "/admin/itsm/categories", title: "Categories", value: `${c.categories} categories, ${c.subs} sub-categories`, text: "The two-level tree offered when raising a ticket." },
    { href: "/admin/itsm/priority", title: "Priority matrix", value: "Impact × urgency", text: "How the priority is worked out from impact and urgency." },
    { href: "/admin/itsm/sla", title: "SLA & OLA", value: `${c.sla} SLA, ${c.ola} OLA policies`, text: "Response and resolution targets." },
    {
      href: "/admin/itsm/calendar",
      title: "Calendar & behaviour",
      value: `${settings.timezone} · ${settings.work_days.map((d) => days[d]).join(" ")} ${settings.work_start}–${settings.work_end}`,
      text: `${settings.holidays.length} holiday${settings.holidays.length === 1 ? "" : "s"}; hold, reopen and auto-close rules.`,
    },
    { href: "/admin/itsm/fields", title: "Custom fields", value: `${c.fields} active field${c.fields === 1 ? "" : "s"}`, text: "Extra information captured on tickets." },
    { href: "/admin/itsm/templates", title: "Email templates", value: `${templates.filter((t) => t.overridden).length} of ${templates.length} customised`, text: "The wording of notification emails." },
    { href: "/admin/itsm/windows", title: "Maintenance windows", value: `${c.windows} window${c.windows === 1 ? "" : "s"}, ${c.freezes} freeze${c.freezes === 1 ? "" : "s"}`, text: "When changes and patches may, or may not, happen." },
  ]
  return (
    <>
      <PageHeader title="ITSM settings" subtitle={`Service management configuration for ${actor.tenant.name}`} back={{ href: "/admin", label: "Administration" }} />
      <ItsmTabs />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((k) => (
          <Link key={k.href} href={k.href} className="block text-inherit no-underline hover:no-underline">
            <div className="card card-body h-full transition-colors hover:border-slate-300">
              <div className="font-medium text-slate-900">{k.title}</div>
              <div className="mt-1 text-sm text-slate-700">{k.value}</div>
              <p className="mt-1 text-xs text-slate-500">{k.text}</p>
            </div>
          </Link>
        ))}
      </div>
    </>
  )
}
