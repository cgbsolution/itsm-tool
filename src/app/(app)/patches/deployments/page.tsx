import Link from "next/link"
import { requirePermission, can } from "@/lib/auth/session"
import { listDeployments } from "@/lib/endpoints/queries"
import { DEPLOYMENT_STATUSES, deploymentTone } from "@/lib/endpoints/vocab"
import { humanize } from "@/lib/itsm/vocab"
import { formatDateTime } from "@/lib/format"
import { Badge, EmptyState, PageHeader, Pagination, Tabs, When, qs } from "@/components/ui"

export const metadata = { title: "Patch deployments" }

type SP = Record<string, string | undefined>

export default async function DeploymentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("endpoint.view")
  const sp = await searchParams
  const tz = actor.tenant.timezone
  const { rows, total, page, pageSize } = await listDeployments(actor, { status: sp.status, page: Number(sp.page) || 1 })
  const base: SP = { ...sp, page: undefined }
  const deploy = can(actor, "patch.deploy")

  return (
    <>
      <PageHeader
        title="Patch deployments"
        subtitle="Approved patches pushed to device groups and devices"
        actions={
          <>
            <Link className="btn" href="/patches">Patch catalog</Link>
            {deploy && <Link className="btn" href="/patches/policies">Policies</Link>}
            {deploy && <Link className="btn btn-primary" href="/patches/deployments/new">New deployment</Link>}
          </>
        }
      />
      <Tabs
        items={[
          { href: "/patches/deployments", label: "All", active: !sp.status },
          ...DEPLOYMENT_STATUSES.filter((s) => s !== "draft").map((s) => ({ href: `/patches/deployments?status=${s}`, label: humanize(s), active: sp.status === s })),
        ]}
      />
      {rows.length === 0 ? (
        <EmptyState title="No deployments" action={deploy ? <Link className="btn btn-primary" href="/patches/deployments/new">New deployment</Link> : undefined}>
          Approve patches in the catalog, then deploy them to a group (for example the Pilot ring first).
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Targets</th>
                <th>Schedule</th>
                <th>Progress</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const pct = d.jobs_total ? Math.round((d.jobs_done / d.jobs_total) * 100) : d.status === "completed" ? 100 : 0
                return (
                  <tr key={d.id}>
                    <td className="max-w-md">
                      <Link href={`/patches/deployments/${d.id}`} className="font-medium">{d.name}</Link>
                      <div className="text-xs text-slate-500">
                        {d.patch_count} patch{d.patch_count === 1 ? "" : "es"}
                        {d.policy_name ? ` · policy ${d.policy_name}` : ""}
                        {d.change_number ? ` · ${d.change_number}` : ""}
                      </div>
                    </td>
                    <td><Badge tone={deploymentTone(d.status)}>{d.status}</Badge></td>
                    <td className="text-slate-600">
                      {[d.group_names.join(", "), d.device_count ? `${d.device_count} device${d.device_count === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ") || "—"}
                    </td>
                    <td className="text-xs text-slate-500">
                      {d.maintenance_window_name ? `Window: ${d.maintenance_window_name}` : d.scheduled_at ? formatDateTime(d.scheduled_at, tz) : "Immediately"}
                      {d.status === "scheduled" && d.scheduled_at && d.maintenance_window_name && <div>next {formatDateTime(d.scheduled_at, tz)}</div>}
                    </td>
                    <td className="min-w-40">
                      {d.jobs_total > 0 ? (
                        <>
                          <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
                            <div className={`h-full ${d.jobs_failed ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {d.jobs_done}/{d.jobs_total} devices done{d.jobs_failed ? `, ${d.jobs_failed} failed` : ""}
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">{d.status === "scheduled" ? "Not started" : "No jobs"}</span>
                      )}
                    </td>
                    <td className="text-xs whitespace-nowrap text-slate-500">
                      <When value={d.created_at} timeZone={tz} />
                      {d.created_by_name ? <div>{d.created_by_name}</div> : d.policy_name ? <div>by policy</div> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/patches/deployments${qs(base, { page: p })}`} />
    </>
  )
}
