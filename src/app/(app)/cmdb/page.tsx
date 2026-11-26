import Link from "next/link"
import { requirePermission, can } from "@/lib/auth/session"
import { filtersFromParams, listCis, listClasses, locationOptions } from "@/lib/cmdb/queries"
import { CI_STATUSES, CI_STATUS_LABELS } from "@/lib/cmdb/vocab"
import { todayIn } from "@/lib/cmdb/values"
import { Badge, EmptyState, PageHeader, Pagination, qs } from "@/components/ui"
import { CiStatusBadge, WarrantyBadge } from "./ui"

export const metadata = { title: "CMDB" }

type SP = Record<string, string | undefined>

export default async function CmdbPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("cmdb.view")
  const sp = await searchParams
  const filters = filtersFromParams(sp)
  const [{ rows, total, page, pageSize }, classes, locations] = await Promise.all([
    listCis(actor, filters),
    listClasses(actor),
    locationOptions(actor.tenantId),
  ])
  const base: SP = { q: sp.q, class: sp.class, status: sp.status, owner: sp.owner, location: sp.location, warranty: sp.warranty, sort: sp.sort }
  const today = todayIn(actor.tenant.timezone)
  const filtered = Object.entries(base).some(([k, v]) => k !== "sort" && v)
  const editor = can(actor, "cmdb.edit")

  return (
    <>
      <PageHeader
        title="Configuration items"
        subtitle={`${total} item${total === 1 ? "" : "s"}${filtered ? " match these filters" : ""}`}
        actions={
          <>
            <a className="btn" href={`/api/export/cis${qs(base)}`}>Export CSV</a>
            <Link className="btn" href="/cmdb/classes">Classes</Link>
            {editor && <Link className="btn" href="/cmdb/import">Import</Link>}
            {editor && <Link className="btn btn-primary" href="/cmdb/new">New item</Link>}
          </>
        }
      />

      <form className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-7" method="get">
        <input name="q" defaultValue={sp.q} placeholder="Code, name, serial…" className="input lg:col-span-2" aria-label="Search" />
        <select name="class" defaultValue={sp.class ?? ""} className="input" aria-label="Class">
          <option value="">All classes</option>
          {classes.map((c) => (
            <option key={c.id} value={c.key}>{c.name}{c.is_active ? "" : " (inactive)"}</option>
          ))}
        </select>
        <select name="status" defaultValue={sp.status ?? ""} className="input" aria-label="Status">
          <option value="">Any status</option>
          <option value="active">Active (not retired)</option>
          {CI_STATUSES.map((s) => (
            <option key={s} value={s}>{CI_STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select name="owner" defaultValue={sp.owner ?? ""} className="input" aria-label="Owner">
          <option value="">Any owner</option>
          <option value="me">Mine</option>
          <option value="none">No owner</option>
        </select>
        <input name="location" defaultValue={sp.location} placeholder="Location" className="input" list="cmdb-locations" aria-label="Location" />
        <datalist id="cmdb-locations">
          {locations.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <div className="flex gap-2">
          <select name="warranty" defaultValue={sp.warranty ?? ""} className="input" aria-label="Warranty">
            <option value="">Any warranty</option>
            <option value="expiring">Ends within 30 days</option>
            <option value="expired">Expired</option>
          </select>
          <button className="btn btn-primary">Filter</button>
        </div>
        <input type="hidden" name="sort" value={sp.sort ?? ""} />
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? "Nothing matches" : "No configuration items yet"}
          action={
            !filtered && editor ? (
              <div className="flex justify-center gap-2">
                <Link className="btn btn-primary" href="/cmdb/new">Add an item</Link>
                <Link className="btn" href="/cmdb/import">Import a CSV</Link>
              </div>
            ) : undefined
          }
        >
          {filtered ? "No configuration items match these filters." : "Add items one by one, import a spreadsheet, or let endpoint agents register devices."}
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th><Link href={`/cmdb${qs(base, { sort: undefined })}`}>Code</Link></th>
                <th><Link href={`/cmdb${qs(base, { sort: "name" })}`}>Name</Link></th>
                <th>Class</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Location</th>
                <th><Link href={`/cmdb${qs(base, { sort: "warranty" })}`}>Warranty</Link></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap">
                    <Link href={`/cmdb/${c.id}`} className="font-mono text-xs font-medium">{c.ci_code}</Link>
                    {c.source === "agent" && <div className="mt-0.5"><Badge tone="purple">agent</Badge></div>}
                  </td>
                  <td className="max-w-md">
                    <Link href={`/cmdb/${c.id}`} className="text-slate-800">{c.name}</Link>
                    {c.serial_no && <div className="text-xs text-slate-500">S/N {c.serial_no}</div>}
                  </td>
                  <td className="text-slate-600">{c.class_name}</td>
                  <td><CiStatusBadge status={c.status} /></td>
                  <td className="text-slate-600">{c.owner_name || c.owner_email || <span className="text-slate-400">—</span>}</td>
                  <td className="text-slate-600">
                    {c.location ?? <span className="text-slate-400">—</span>}
                    {c.room && <div className="text-xs text-slate-400">Room {c.room}</div>}
                  </td>
                  <td><WarrantyBadge expiry={c.warranty_expiry} today={today} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/cmdb${qs(base, { page: p })}`} />
    </>
  )
}
