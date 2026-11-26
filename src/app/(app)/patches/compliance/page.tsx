import Link from "next/link"
import { requirePermission, can } from "@/lib/auth/session"
import { complianceSummary } from "@/lib/endpoints/queries"
import { approvalTone, severityTone } from "@/lib/endpoints/vocab"
import { humanize } from "@/lib/itsm/vocab"
import { pct } from "@/lib/format"
import { Badge, Card, EmptyState, PageHeader, Stat, When } from "@/components/ui"

export const metadata = { title: "Patch compliance" }

function Bar({ part, whole }: { part: number; whole: number }) {
  const v = whole ? Math.round((part / whole) * 100) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
      <div className={`h-full ${v >= 95 ? "bg-emerald-500" : v >= 80 ? "bg-amber-500" : "bg-red-500"}`} style={{ width: `${v}%` }} />
    </div>
  )
}

export default async function CompliancePage() {
  const actor = await requirePermission("endpoint.view")
  const tz = actor.tenant.timezone
  const s = await complianceSummary(actor.tenantId)
  const rate = s.total ? Math.round((s.compliant / s.total) * 100) : null

  return (
    <>
      <PageHeader
        back={{ href: "/patches", label: "Patches" }}
        title="Patch compliance"
        subtitle="A device is compliant when no approved security or critical patch is missing (pending reboot counts as installed)."
        actions={can(actor, "report.view") ? <a className="btn" href="/api/export/compliance">Export CSV</a> : undefined}
      />
      {s.total === 0 ? (
        <EmptyState title="No managed devices yet" action={can(actor, "endpoint.manage") ? <Link className="btn btn-primary" href="/endpoints/enrol">Enrol devices</Link> : undefined} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Compliant" value={rate === null ? "—" : `${rate}%`} tone={rate === null ? undefined : rate >= 95 ? "green" : rate >= 80 ? "amber" : "red"} sub={`${s.compliant} of ${s.total} active devices`} />
            <Stat label="Not compliant" value={s.total - s.compliant} href="/endpoints?missing=critical" tone={s.total - s.compliant ? "red" : "green"} sub="missing approved security/critical" />
            <Stat label="Not seen in 7 days" value={s.stale.length} href="/endpoints?seen=stale" tone={s.stale.length ? "amber" : undefined} sub={`${s.neverScanned} never scanned`} />
            <Stat label="Reboot pending" value={s.rebootPending} href="/endpoints?reboot=1" tone={s.rebootPending ? "amber" : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="By device group" bodyClassName="p-0">
              <table className="table">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th className="text-right">Devices</th>
                    <th className="text-right">Compliant</th>
                    <th className="w-40"></th>
                  </tr>
                </thead>
                <tbody>
                  {s.groups.map((g) => (
                    <tr key={g.group_id ?? "none"}>
                      <td>
                        <Link href={`/endpoints?group=${g.group_id ?? "none"}`}>{g.name}</Link>
                      </td>
                      <td className="text-right">{g.devices}</td>
                      <td className="text-right">{pct(g.compliant, g.devices)}</td>
                      <td className="align-middle"><Bar part={g.compliant} whole={g.devices} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card title="Top 10 missing patches" bodyClassName="p-0">
              {s.topMissing.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">Nothing is missing.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Patch</th>
                      <th>Severity</th>
                      <th>Approval</th>
                      <th className="text-right">Devices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.topMissing.map((p) => (
                      <tr key={p.id}>
                        <td className="max-w-xs">
                          <Link href={`/patches/${p.id}`}>{p.title}</Link>
                          <div className="text-xs text-slate-500">{[p.kb, humanize(p.classification)].filter(Boolean).join(" · ")}</div>
                        </td>
                        <td><Badge tone={severityTone(p.severity)}>{p.severity}</Badge></td>
                        <td><Badge tone={approvalTone(p.approval)}>{p.approval}</Badge></td>
                        <td className="text-right">{p.missing}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card title={`Devices not seen in 7 days (${s.stale.length})`} bodyClassName="p-0">
            {s.stale.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Every active device checked in during the last 7 days.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Group</th>
                    <th>Last seen</th>
                    <th className="text-right">Missing required</th>
                  </tr>
                </thead>
                <tbody>
                  {s.stale.slice(0, 200).map((d) => (
                    <tr key={d.id}>
                      <td><Link href={`/endpoints/${d.id}`}>{d.hostname}</Link></td>
                      <td className="text-slate-600">{d.group_name ?? "—"}</td>
                      <td className="text-xs text-slate-500"><When value={d.last_seen_at} timeZone={tz} /></td>
                      <td className="text-right">{d.missing_required}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
