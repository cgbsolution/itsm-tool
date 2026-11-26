import Link from "next/link"
import { requirePermission, can } from "@/lib/auth/session"
import { listPatches } from "@/lib/endpoints/queries"
import { APPROVALS, CLASSIFICATIONS, OS_FAMILIES, OS_LABELS, SEVERITIES, approvalTone, severityTone, type OsFamily } from "@/lib/endpoints/vocab"
import { humanize } from "@/lib/itsm/vocab"
import { formatDate } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, EmptyState, PageHeader, Pagination, qs } from "@/components/ui"
import { CheckAll } from "../endpoints/client"
import { bulkApprovalAction } from "./actions"

export const metadata = { title: "Patches" }

type SP = Record<string, string | undefined>

export default async function PatchesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await requirePermission("endpoint.view")
  const sp = await searchParams
  const { rows, total, page, pageSize } = await listPatches(actor, {
    q: sp.q,
    os: sp.os,
    severity: sp.severity,
    classification: sp.classification,
    approval: sp.approval,
    missing: sp.missing,
    page: Number(sp.page) || 1,
  })
  const base: SP = { ...sp, page: undefined }
  const approve = can(actor, "patch.approve")

  const table = (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            {approve && (
              <th className="w-8">
                <CheckAll name="ids" />
              </th>
            )}
            <th>Title</th>
            <th>KB</th>
            <th>Severity</th>
            <th>Classification</th>
            <th className="text-right">Missing</th>
            <th className="text-right">Installed</th>
            <th>Approval</th>
            <th>Released</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              {approve && (
                <td>
                  <input type="checkbox" name="ids" value={p.id} aria-label={`Select ${p.title}`} />
                </td>
              )}
              <td className="max-w-xl">
                <Link href={`/patches/${p.id}`} className="text-slate-800">{p.title}</Link>
                <div className="text-xs text-slate-500">
                  {OS_LABELS[p.os_family as OsFamily] ?? p.os_family}
                  {p.os_family !== "windows" ? ` · ${p.external_id}` : ""}
                  {p.package_file_id ? " · offline package" : ""}
                </div>
              </td>
              <td className="font-mono text-xs whitespace-nowrap">{p.kb ?? "—"}</td>
              <td><Badge tone={severityTone(p.severity)}>{p.severity}</Badge></td>
              <td className="text-slate-600">{humanize(p.classification)}</td>
              <td className="text-right">
                {p.missing > 0 ? (
                  <Link href={`/patches/${p.id}#missing`} className={p.failed ? "font-medium text-red-700" : "font-medium"}>
                    {p.missing}
                    {p.failed > 0 ? ` (${p.failed} failed)` : ""}
                  </Link>
                ) : (
                  <span className="text-slate-400">0</span>
                )}
              </td>
              <td className="text-right text-slate-600">{p.installed}</td>
              <td><Badge tone={approvalTone(p.approval)}>{p.approval}</Badge></td>
              <td className="text-xs whitespace-nowrap text-slate-500">{p.release_date ? formatDate(p.release_date) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <>
      <PageHeader
        title="Patches"
        subtitle={`${total} patch${total === 1 ? "" : "es"} in the catalog, from agent scans`}
        actions={
          <>
            <Link className="btn" href="/patches/compliance">Compliance</Link>
            {can(actor, "patch.deploy") && <Link className="btn" href="/patches/policies">Policies</Link>}
            <Link className="btn" href="/patches/deployments">Deployments</Link>
            {can(actor, "patch.deploy") && <Link className="btn btn-primary" href="/patches/deployments/new">New deployment</Link>}
          </>
        }
      />

      <form className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-8" method="get">
        <input name="q" defaultValue={sp.q} placeholder="Title, KB or package…" className="input lg:col-span-2" />
        <select name="os" defaultValue={sp.os ?? ""} className="input" aria-label="Operating system">
          <option value="">Any OS</option>
          {OS_FAMILIES.map((o) => (
            <option key={o} value={o}>{OS_LABELS[o]}</option>
          ))}
        </select>
        <select name="severity" defaultValue={sp.severity ?? ""} className="input" aria-label="Severity">
          <option value="">Any severity</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>{humanize(s)}</option>
          ))}
        </select>
        <select name="classification" defaultValue={sp.classification ?? ""} className="input" aria-label="Classification">
          <option value="">Any classification</option>
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>{humanize(c)}</option>
          ))}
        </select>
        <select name="approval" defaultValue={sp.approval ?? ""} className="input" aria-label="Approval">
          <option value="">Any approval</option>
          {APPROVALS.map((a) => (
            <option key={a} value={a}>{humanize(a)}</option>
          ))}
        </select>
        <div className="flex items-center gap-3 text-sm lg:col-span-2">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="missing" value="1" defaultChecked={sp.missing === "1"} /> Only missing somewhere
          </label>
          <button className="btn btn-primary ml-auto">Filter</button>
        </div>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No patches">
          {total === 0 && !sp.q ? "Patches appear here when enrolled devices report a patch scan." : "No patches match these filters."}
        </EmptyState>
      ) : approve ? (
        <ActionForm action={bulkApprovalAction} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-600">Selected:</span>
            <SubmitButton name="decision" value="approved" className="btn btn-primary btn-sm">Approve</SubmitButton>
            <SubmitButton name="decision" value="declined" className="btn btn-sm">Decline</SubmitButton>
            <SubmitButton name="decision" value="pending" className="btn btn-ghost btn-sm">Reset to pending</SubmitButton>
          </div>
          {table}
        </ActionForm>
      ) : (
        table
      )}
      <Pagination page={page} pageSize={pageSize} total={total} href={(p) => `/patches${qs(base, { page: p })}`} />
    </>
  )
}
