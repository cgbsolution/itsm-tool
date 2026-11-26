import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listWindowsAdmin, RECURRENCE_LABELS, WINDOW_KIND_LABELS, WINDOW_SCOPE_LABELS } from "@/lib/admin/windows"
import { occurrences } from "@/lib/itsm/windows"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, EmptyState, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../tabs"
import { WindowFields } from "./form"
import { createWindowAction } from "../actions"

export const metadata = { title: "Maintenance windows" }

export default async function WindowsPage() {
  const actor = await requirePermission("admin.itsm")
  const windows = await listWindowsAdmin(actor)
  const tz = actor.tenant.timezone
  const now = new Date()
  const horizon = new Date(now.getTime() + 3 * 366 * 86_400_000)
  return (
    <>
      <PageHeader title="ITSM settings" subtitle="Maintenance windows and change freezes" back={{ href: "/admin/itsm", label: "ITSM settings" }} />
      <ItsmTabs active="windows" />
      <p className="hint mb-4">
        Changes and patch deployments cannot be scheduled into a change freeze. Patch deployments can be timed into the next maintenance window. Times are in {tz}.
      </p>
      {windows.length === 0 ? (
        <EmptyState title="No windows yet">Add a maintenance window or a change freeze below.</EmptyState>
      ) : (
        <div className="mb-4 space-y-3">
          {windows.map((w) => {
            const next = occurrences(w, now, horizon, 5)
            return (
              <section key={w.id} className={`card card-body ${w.is_active ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/admin/itsm/windows/${w.id}`} className="font-medium">
                        {w.name}
                      </Link>
                      <Badge tone={w.kind === "blackout" ? "red" : "blue"}>{WINDOW_KIND_LABELS[w.kind]}</Badge>
                      <Badge>{WINDOW_SCOPE_LABELS[w.applies_to]}</Badge>
                      {!w.is_active && <Badge>Inactive</Badge>}
                    </div>
                    {w.description && <p className="prose-plain mt-1 text-sm text-slate-600">{w.description}</p>}
                    <div className="mt-1 text-xs text-slate-500">
                      {formatDateTime(w.starts_at, tz)} → {formatDateTime(w.ends_at, tz)} · {RECURRENCE_LABELS[w.recurrence]}
                      {w.recurrence !== "none" && w.recurrence_until && ` until ${formatDateTime(w.recurrence_until, tz)}`}
                    </div>
                  </div>
                  <Link href={`/admin/itsm/windows/${w.id}`} className="btn btn-sm">
                    Edit
                  </Link>
                </div>
                <div className="mt-3 border-t border-slate-100 pt-2">
                  <div className="text-xs font-medium text-slate-500">Next occurrences</div>
                  {next.length === 0 ? (
                    <p className="text-sm text-slate-400">None upcoming</p>
                  ) : (
                    <ul className="mt-1 grid gap-x-6 gap-y-0.5 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
                      {next.map((o) => (
                        <li key={o.start.toISOString()}>
                          {formatDateTime(o.start, tz)} → {formatDateTime(o.end, tz)}
                          {o.start <= now && <span className="ml-1 text-xs text-emerald-700">(now)</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}
      <details className="card max-w-4xl" open={windows.length === 0}>
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Add a window</summary>
        <div className="border-t border-slate-100 p-4">
          <ActionForm action={createWindowAction} className="space-y-3">
            <WindowFields timeZone={tz} />
            <SubmitButton>Add window</SubmitButton>
          </ActionForm>
        </div>
      </details>
    </>
  )
}
