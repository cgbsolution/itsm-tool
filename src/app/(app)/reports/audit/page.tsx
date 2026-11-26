import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { auditFacets, listAudit, type AuditFilters } from "@/lib/reports/audit"
import { ActionForm, SubmitButton } from "@/components/client"
import { EmptyState, PageHeader, Pagination, qs } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { verifyAuditAction } from "./actions"

export const metadata = { title: "Audit log" }

type SP = Record<string, string | undefined>

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("audit.view")
  const sp = await searchParams
  const tz = actor.tenant.timezone
  const filters: AuditFilters = {
    action: sp.action,
    actor: sp.actor,
    entityType: sp.entityType,
    entityId: sp.entityId,
    from: sp.from,
    to: sp.to,
    tenant: actor.isSuperadmin ? sp.tenant : undefined,
    page: Number(sp.page) || 1,
  }
  const [{ rows, total, page, pageSize }, facets] = await Promise.all([listAudit(actor, filters), auditFacets(actor)])
  const tenants = facets.tenants
  const base: SP = { ...sp, page: undefined }
  const exportParams: SP = { ...base, tenant: actor.isSuperadmin ? sp.tenant : undefined }

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle={actor.isSuperadmin ? "All tenants and system events (you are a super administrator)" : `Security-relevant events in ${actor.tenant.name}`}
        actions={
          <>
            <a className="btn" href={`/api/export/audit${qs(exportParams)}`}>
              Export CSV
            </a>
            <ActionForm action={verifyAuditAction}>
              <SubmitButton className="btn btn-primary" pendingText="Verifying…">
                Verify integrity
              </SubmitButton>
            </ActionForm>
          </>
        }
      />
      <p className="-mt-3 mb-4 text-xs text-slate-500">
        The log is append-only and hash-chained: each entry includes the hash of the one before, so a changed or deleted entry breaks the chain. Verification checks the whole
        installation&apos;s chain.
      </p>

      <form method="get" className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-8">
        <input name="action" defaultValue={sp.action} placeholder="Action starts with… (e.g. admin.)" className="input lg:col-span-2" list="audit-actions" />
        <datalist id="audit-actions">
          {facets.actionPrefixes.map((a) => (
            <option key={a} value={`${a}.`} />
          ))}
        </datalist>
        <input name="actor" defaultValue={sp.actor} placeholder="Actor email" className="input" />
        <select name="entityType" defaultValue={sp.entityType ?? ""} className="input">
          <option value="">Any entity</option>
          {facets.entityTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input name="entityId" defaultValue={sp.entityId} placeholder="Entity id" className="input" />
        <input name="from" type="date" defaultValue={sp.from} className="input" aria-label="From date" title="From" />
        <input name="to" type="date" defaultValue={sp.to} className="input" aria-label="To date" title="To" />
        <div className="flex gap-2">
          {actor.isSuperadmin && (
            <select name="tenant" defaultValue={sp.tenant ?? ""} className="input" aria-label="Tenant">
              <option value="">All tenants</option>
              <option value="system">System (no tenant)</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          <button className="btn btn-primary">Filter</button>
        </div>
        {Object.values(base).some(Boolean) && (
          <Link href="/reports/audit" className="self-center text-xs lg:col-span-8">
            Clear filters
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No entries">No audit entries match these filters.</EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                {actor.isSuperadmin && <th>Tenant</th>}
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Summary</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="text-xs whitespace-nowrap text-slate-500">
                    {formatDateTime(a.created_at, tz)}
                    <div className="font-mono text-[10px] text-slate-400">#{a.id}</div>
                  </td>
                  {actor.isSuperadmin && <td className="text-xs">{a.tenant_name ?? <span className="text-slate-400">system</span>}</td>}
                  <td className="max-w-[14rem] text-xs break-words">
                    {a.actor_label ? (
                      <Link href={`/reports/audit${qs({ actor: a.actor_label })}`} className="text-slate-700">
                        {a.actor_label}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="font-mono text-xs whitespace-nowrap">{a.action}</td>
                  <td className="text-xs">
                    {a.entity_type ? (
                      <Link href={`/reports/audit${qs({ entityType: a.entity_type, entityId: a.entity_id ?? undefined })}`} className="text-slate-700">
                        {a.entity_type}
                        {a.entity_id && <div className="max-w-[12rem] truncate font-mono text-[10px] text-slate-400">{a.entity_id}</div>}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="max-w-md text-sm">
                    <span className="prose-plain">{a.summary ?? ""}</span>
                    {a.data && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-slate-400">Data</summary>
                        <pre className="mt-1 max-h-72 max-w-md overflow-auto rounded bg-slate-50 p-2 text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(a.data, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                  <td className="font-mono text-xs text-slate-500">{a.ip ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/reports/audit${qs(base, { page: p })}`} />
    </>
  )
}
