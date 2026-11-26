import Link from "next/link"
import { requirePermission, can } from "@/lib/auth/session"
import { listDevices, listDeviceGroups } from "@/lib/endpoints/queries"
import { ONLINE_MINUTES, OS_FAMILIES, OS_LABELS, STALE_DAYS, type OsFamily } from "@/lib/endpoints/vocab"
import { Badge, EmptyState, PageHeader, Pagination, When, qs } from "@/components/ui"

export const metadata = { title: "Devices" }

type SP = Record<string, string | undefined>

function SeenDot({ at }: { at: Date | null }) {
  const ms = at ? Date.now() - new Date(at).getTime() : Infinity
  const cls = ms < ONLINE_MINUTES * 60_000 ? "bg-emerald-500" : ms < STALE_DAYS * 86_400_000 ? "bg-slate-300" : "bg-red-400"
  const label = ms < ONLINE_MINUTES * 60_000 ? "Online" : ms < STALE_DAYS * 86_400_000 ? "Offline" : "Stale"
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} title={label} aria-label={label} />
}

export default async function DevicesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("endpoint.view")
  const sp = await searchParams
  const tz = actor.tenant.timezone
  const [{ rows, total, page, pageSize }, groups] = await Promise.all([
    listDevices(actor, { q: sp.q, os: sp.os, group: sp.group, seen: sp.seen, missing: sp.missing, reboot: sp.reboot, status: sp.status, page: Number(sp.page) || 1 }),
    listDeviceGroups(actor.tenantId),
  ])
  const base: SP = { ...sp, page: undefined }
  const manage = can(actor, "endpoint.manage")

  return (
    <>
      <PageHeader
        title="Devices"
        subtitle={`${total} ${sp.status === "retired" ? "retired" : sp.status === "all" ? "" : "managed"} device${total === 1 ? "" : "s"}`}
        actions={
          <>
            <Link className="btn" href="/patches/compliance">Compliance</Link>
            {manage && <Link className="btn" href="/endpoints/groups">Device groups</Link>}
            {manage && <Link className="btn btn-primary" href="/endpoints/enrol">Enrol devices</Link>}
          </>
        }
      />

      <form className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-8" method="get">
        <input name="q" defaultValue={sp.q} placeholder="Host name, serial, IP or user…" className="input lg:col-span-2" />
        <select name="os" defaultValue={sp.os ?? ""} className="input" aria-label="Operating system">
          <option value="">Any OS</option>
          {OS_FAMILIES.map((o) => (
            <option key={o} value={o}>{OS_LABELS[o]}</option>
          ))}
        </select>
        <select name="group" defaultValue={sp.group ?? ""} className="input" aria-label="Group">
          <option value="">Any group</option>
          <option value="none">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <select name="seen" defaultValue={sp.seen ?? ""} className="input" aria-label="Last seen">
          <option value="">Any last seen</option>
          <option value="online">Online (seen in {ONLINE_MINUTES} min)</option>
          <option value="offline">Offline</option>
          <option value="stale">Stale (over {STALE_DAYS} days)</option>
        </select>
        <select name="status" defaultValue={sp.status ?? "active"} className="input" aria-label="Status">
          <option value="active">Active</option>
          <option value="retired">Retired</option>
          <option value="all">Active and retired</option>
        </select>
        <div className="flex flex-wrap items-center gap-3 text-sm lg:col-span-2">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="missing" value="critical" defaultChecked={sp.missing === "critical"} /> Missing critical
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="reboot" value="1" defaultChecked={sp.reboot === "1"} /> Reboot pending
          </label>
          <button className="btn btn-primary ml-auto">Filter</button>
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No devices" action={manage ? <Link className="btn btn-primary" href="/endpoints/enrol">Enrol devices</Link> : undefined}>
          {total === 0 && !sp.q && !sp.os && !sp.group && !sp.seen ? "Install the agent on a device with an enrolment token and it appears here." : "No devices match these filters."}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Host name</th>
                <th>OS</th>
                <th>Group</th>
                <th>Last seen</th>
                <th>Missing patches</th>
                <th>Reboot</th>
                <th>Agent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <SeenDot at={d.last_seen_at} />
                      <Link href={`/endpoints/${d.id}`} className="font-medium">{d.hostname}</Link>
                      {d.status === "retired" && <Badge>Retired</Badge>}
                    </div>
                    <div className="mt-0.5 pl-4 text-xs text-slate-500">
                      {[d.serial_no, d.last_ip].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </td>
                  <td className="text-slate-600">
                    <div>{d.os_name ?? OS_LABELS[d.os_family as OsFamily] ?? d.os_family}</div>
                    {d.os_version && <div className="text-xs text-slate-400">{d.os_version}</div>}
                  </td>
                  <td className="text-slate-600">{d.group_name ?? <span className="text-slate-400">—</span>}</td>
                  <td className="whitespace-nowrap text-xs text-slate-500">
                    <When value={d.last_seen_at} timeZone={tz} />
                  </td>
                  <td className="whitespace-nowrap">
                    {d.missing === 0 ? (
                      <span className="text-xs text-slate-400">None</span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <span className="text-slate-700">{d.missing}</span>
                        {d.missing_critical > 0 && <Badge tone="red">{d.missing_critical} critical</Badge>}
                      </span>
                    )}
                  </td>
                  <td>{d.reboot_pending ? <Badge tone="purple">Pending</Badge> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="font-mono text-xs text-slate-500">{d.agent_version ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/endpoints${qs(base, { page: p })}`} />
    </>
  )
}
