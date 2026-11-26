"use client"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useState } from "react"
import {
  LayoutDashboard, Ticket, Inbox, Bug, GitPullRequest, CalendarRange, CheckSquare, ShoppingBag, BookOpen,
  Boxes, Monitor, ShieldCheck, Rocket, BarChart3, ScrollText, Settings, Menu, X, type LucideIcon,
} from "lucide-react"

const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard, tickets: Ticket, inbox: Inbox, problem: Bug, change: GitPullRequest, calendar: CalendarRange,
  approvals: CheckSquare, catalog: ShoppingBag, kb: BookOpen, cmdb: Boxes, devices: Monitor, patches: ShieldCheck,
  deploy: Rocket, reports: BarChart3, audit: ScrollText, admin: Settings,
}

export type NavItem = { href: string; label: string; icon: string; badge?: number }
export type NavSection = { title?: string; items: NavItem[] }

function isActive(href: string, pathname: string, search: URLSearchParams) {
  const [path, query] = href.split("?")
  if (path === "/") return pathname === "/"
  if (!(pathname === path || pathname.startsWith(path + "/"))) return false
  if (!query) {
    // a bare list link is not active when a filtered sibling is (e.g. /tickets vs /tickets?type=problem)
    return !(path === "/tickets" && search.get("type") && ["problem", "change"].includes(search.get("type")!))
  }
  const want = new URLSearchParams(query)
  for (const [k, v] of want) if (search.get(k) !== v) return false
  return true
}

export function SideNav({ sections, brand }: { sections: NavSection[]; brand: string }) {
  const pathname = usePathname()
  const search = useSearchParams()
  const [open, setOpen] = useState(false)
  const nav = (
    <nav className="space-y-5 px-3 py-4">
      {sections.map((s, i) => (
        <div key={i}>
          {s.title && <div className="mb-1 px-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{s.title}</div>}
          <ul className="space-y-0.5">
            {s.items.map((it) => {
              const Icon = ICONS[it.icon] ?? Ticket
              const active = isActive(it.href, pathname, search)
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    onClick={() => setOpen(false)}
                    className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm no-underline hover:no-underline ${
                      active ? "bg-brand/10 font-medium text-brand" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{it.label}</span>
                    {!!it.badge && <span className="rounded-full bg-red-600 px-1.5 text-[10px] leading-4 font-semibold text-white">{it.badge}</span>}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
  return (
    <>
      <button type="button" className="btn btn-ghost fixed top-2.5 left-2 z-40 lg:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-60 overflow-y-auto border-r border-slate-200 bg-white transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-sm font-bold text-white">{brand.charAt(0)}</div>
          <span className="truncate text-sm font-semibold text-slate-900">{brand}</span>
        </div>
        {nav}
      </aside>
    </>
  )
}
