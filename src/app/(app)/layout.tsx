import type { CSSProperties, ReactNode } from "react"
import { Suspense } from "react"
import Link from "next/link"
import { redirect } from "next/navigation"
import { requireActor, can } from "@/lib/auth/session"
import { q1 } from "@/lib/db"
import { FlashFromUrl, NotificationBell } from "@/components/client"
import { SideNav, type NavSection } from "@/components/nav"
import { logoutAction } from "../(auth)/actions"
import { licenseStatus } from "@/lib/license"

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor()
  if (actor.mustChangePassword) redirect("/account/password")
  if (actor.tenant.requireMfa && !actor.mfaEnabled) redirect("/account/mfa")

  const [unread, approvals, license] = await Promise.all([
    q1<{ n: number }>("select count(*) as n from notifications where user_id = $1 and not is_read", [actor.id]),
    q1<{ n: number }>(
      `select count(*) as n from approvals a join tickets t on t.id = a.ticket_id
        where a.tenant_id = $1 and a.status = 'pending' and (a.approver_id = $2 or a.group_id = any($3::uuid[]))
          and coalesce(t.created_by, '00000000-0000-0000-0000-000000000000') <> $2`,
      [actor.tenantId, actor.id, actor.groupIds]
    ),
    licenseStatus(),
  ])

  const staff = can(actor, "ticket.view_all")
  const sections: NavSection[] = [
    {
      items: [
        { href: "/", label: "Dashboard", icon: "dashboard" },
        { href: "/tickets", label: staff ? "All tickets" : "My tickets", icon: "tickets" },
        ...(can(actor, "ticket.work") ? [{ href: "/tickets?assignee=me", label: "My work", icon: "inbox" }] : []),
        { href: "/approvals", label: "Approvals", icon: "approvals", badge: approvals?.n ?? 0 },
      ],
    },
    {
      title: "Service management",
      items: [
        ...(can(actor, "problem.manage") ? [{ href: "/tickets?type=problem", label: "Problems", icon: "problem" }] : []),
        ...(can(actor, "change.manage")
          ? [
              { href: "/tickets?type=change", label: "Changes", icon: "change" },
              { href: "/changes/calendar", label: "Change calendar", icon: "calendar" },
            ]
          : []),
        { href: "/catalog", label: "Service catalog", icon: "catalog" },
        { href: "/kb", label: "Knowledge base", icon: "kb" },
      ],
    },
    {
      title: "Assets & endpoints",
      items: [
        ...(can(actor, "cmdb.view") ? [{ href: "/cmdb", label: "CMDB", icon: "cmdb" }] : []),
        ...(can(actor, "endpoint.view")
          ? [
              { href: "/endpoints", label: "Devices", icon: "devices" },
              { href: "/patches", label: "Patches", icon: "patches" },
              { href: "/patches/deployments", label: "Deployments", icon: "deploy" },
            ]
          : []),
      ],
    },
    {
      title: "Insights",
      items: [
        ...(can(actor, "report.view") ? [{ href: "/reports", label: "Reports", icon: "reports" }] : []),
        ...(can(actor, "audit.view") ? [{ href: "/reports/audit", label: "Audit log", icon: "audit" }] : []),
        ...([...actor.permissions].some((p) => p.startsWith("admin.")) ? [{ href: "/admin", label: "Administration", icon: "admin" }] : []),
      ],
    },
  ].filter((s) => s.items.length > 0)

  return (
    <div style={{ "--brand": actor.tenant.brandColor } as CSSProperties} className="min-h-screen">
      <Suspense fallback={null}>
        <SideNav sections={sections} brand={actor.tenant.brandName} />
      </Suspense>
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 pl-14 backdrop-blur lg:pl-6">
          <form action="/search" className="max-w-md flex-1">
            <input name="q" type="search" placeholder="Search tickets, CIs, articles, devices…" className="input" aria-label="Search" />
          </form>
          <div className="ml-auto flex items-center gap-2">
            {actor.isSuperadmin && actor.tenantId !== actor.homeTenantId && (
              <span className="badge bg-amber-100 text-amber-800">Viewing {actor.tenant.name}</span>
            )}
            <NotificationBell initial={unread?.n ?? 0} />
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-100">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
                  {actor.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
                </span>
                <span className="hidden max-w-40 truncate sm:inline">{actor.name}</span>
              </summary>
              <div className="absolute right-0 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
                <div className="border-b border-slate-100 px-3 py-2">
                  <div className="truncate font-medium">{actor.name}</div>
                  <div className="truncate text-xs text-slate-500">{actor.roleName}</div>
                </div>
                <Link href="/profile" className="block px-3 py-1.5 text-slate-700 no-underline hover:bg-slate-50 hover:no-underline">Profile & security</Link>
                <Link href="/notifications" className="block px-3 py-1.5 text-slate-700 no-underline hover:bg-slate-50 hover:no-underline">Notifications</Link>
                <form action={logoutAction}>
                  <button className="block w-full px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50">Sign out</button>
                </form>
              </div>
            </details>
          </div>
        </header>
        {license.banner && (
          <div className={`px-6 py-1.5 text-xs ${license.level === "error" ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"}`}>{license.banner}</div>
        )}
        <main className="mx-auto max-w-[1400px] p-4 lg:p-6">
          <Suspense>
            <FlashFromUrl />
          </Suspense>
          {children}
        </main>
      </div>
    </div>
  )
}
