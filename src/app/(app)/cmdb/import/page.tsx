import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { previewImport } from "@/lib/cmdb/import"
import { IMPORT_MAX_ROWS } from "@/lib/cmdb/mapping"
import { CI_STATUS_LABELS, FIELD_LABELS } from "@/lib/cmdb/vocab"
import { formatDateTime, bytes } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, PageHeader, Stat } from "@/components/ui"
import { commitImportAction, uploadImportAction } from "../actions"

export const metadata = { title: "Import configuration items" }

const PREVIEW_ROWS = 20
const MAX_LISTED = 200

function UploadCard() {
  return (
    <Card title="Upload a CSV file">
      <ActionForm action={uploadImportAction} className="space-y-3">
        <input type="file" name="file" accept=".csv,text/csv,text/plain" required className="block w-full text-sm" />
        <p className="hint">
          Up to 5 MB and {IMPORT_MAX_ROWS.toLocaleString("en")} rows, comma- or semicolon-separated, UTF-8 (Excel “CSV UTF-8” works). Nothing is
          changed until you check the preview and confirm.
        </p>
        <SubmitButton pendingText="Reading…">Upload and preview</SubmitButton>
      </ActionForm>
    </Card>
  )
}

function ColumnsHelp() {
  const rows: [string, string][] = [
    ["ci_code", "Required. Aliases: asset_code, code. Existing codes are updated, new ones created (case-insensitive)."],
    ["name", "Aliases: asset_name, ci_name. New items without a name use the code."],
    ["class", "Aliases: asset_type, type. A class key or name, or free text such as “Laptop”, “Dell desktop”, “Switch”."],
    ["status", "in_use, in_stock (also “spare”), planned, maintenance, retired, disposed."],
    ["condition", "new, good, fair, poor, damaged."],
    ["owner_email", "Alias: assigned_to_email. Must be an active user; otherwise the owner is left unchanged."],
    ["serial_no, model, manufacturer", "Aliases: serial, vendor."],
    ["location, room, department", ""],
    ["purchase_date, warranty_years, warranty_expiry", "Dates as YYYY-MM-DD or DD/MM/YYYY. Expiry is worked out from purchase date + years when missing."],
    ["environment, criticality, cost, notes", "Optional."],
    ["anything else", "Stored as an attribute, e.g. cpu, ram, storage, os_name, mac_address."],
  ]
  return (
    <Card title="Columns">
      <dl className="space-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="font-mono text-xs text-slate-700">{k}</dt>
            {v && <dd className="text-xs text-slate-500">{v}</dd>}
          </div>
        ))}
      </dl>
      <p className="hint">Empty cells leave existing values unchanged. The export from the CMDB list can be edited and imported back.</p>
    </Card>
  )
}

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ file?: string }> }) {
  const actor = await requirePermission("cmdb.edit")
  const sp = await searchParams
  const tz = actor.tenant.timezone

  if (!sp.file) {
    return (
      <>
        <PageHeader title="Import configuration items" back={{ href: "/cmdb", label: "CMDB" }} />
        <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
          <UploadCard />
          <ColumnsHelp />
        </div>
      </>
    )
  }

  let result: Awaited<ReturnType<typeof previewImport>> | null = null
  let error: string | null = null
  try {
    result = await previewImport(actor, sp.file)
  } catch (e) {
    if (!(e instanceof AppError)) throw e
    error = e.message
  }

  if (!result) {
    return (
      <>
        <PageHeader title="Import configuration items" back={{ href: "/cmdb", label: "CMDB" }} />
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
        <UploadCard />
      </>
    )
  }

  const { file, committed, plan } = result
  if (committed) {
    const s = committed.summary
    return (
      <>
        <PageHeader
          title="Import finished"
          subtitle={`${file.file_name} · imported ${formatDateTime(committed.at, tz)}`}
          back={{ href: "/cmdb", label: "CMDB" }}
          actions={
            <>
              <Link className="btn" href="/cmdb/import">Import another file</Link>
              <Link className="btn btn-primary" href="/cmdb?sort=updated">View items</Link>
            </>
          }
        />
        <div className="mb-4 grid gap-3 sm:grid-cols-5">
          <Stat label="Rows" value={s.rows} />
          <Stat label="Created" value={s.created} tone="green" />
          <Stat label="Updated" value={s.updated} />
          <Stat label="Unchanged" value={s.unchanged} />
          <Stat label="Skipped" value={s.skipped} tone={s.skipped ? "red" : undefined} />
        </div>
        {s.errors.length > 0 && (
          <Card title={`Errors (${s.errors.length}${s.skipped > s.errors.length ? "+" : ""})`} className="mb-4">
            <IssueList items={s.errors.slice(0, MAX_LISTED)} tone="red" />
          </Card>
        )}
        {s.warnings.length > 0 && (
          <Card title={`Warnings (${s.warnings.length})`}>
            <IssueList items={s.warnings.slice(0, MAX_LISTED)} tone="amber" />
          </Card>
        )}
      </>
    )
  }

  const p = plan!
  const errorRows = p.rows.filter((r) => r.errors.length > 0)
  const warningRows = p.rows.filter((r) => r.warnings.length > 0)
  const writable = p.counts.create + p.counts.update
  return (
    <>
      <PageHeader
        title="Check the import"
        subtitle={`${file.file_name} · ${bytes(file.size_bytes)} · ${p.delimiter === ";" ? "semicolon" : p.delimiter === "\t" ? "tab" : "comma"}-separated`}
        back={{ href: "/cmdb", label: "CMDB" }}
        actions={<Link className="btn" href="/cmdb/import">Upload a different file</Link>}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Rows" value={p.counts.rows} />
        <Stat label="New items" value={p.counts.create} tone="green" />
        <Stat label="Updates" value={p.counts.update} />
        <Stat label="With errors" value={p.counts.error} tone={p.counts.error ? "red" : undefined} sub={p.counts.error ? "skipped on import" : undefined} />
      </div>

      <Card title="Import" className="mb-4">
        {writable === 0 ? (
          <p className="text-sm text-red-700">No row can be imported. Fix the errors below and upload the file again.</p>
        ) : (
          <ActionForm
            action={commitImportAction.bind(null, file.id)}
            confirm={`Import ${writable} row${writable === 1 ? "" : "s"} now (${p.counts.create} new, ${p.counts.update} updates)?`}
            className="flex flex-wrap items-center gap-3"
          >
            <SubmitButton pendingText="Importing…">
              Import {writable} row{writable === 1 ? "" : "s"}
            </SubmitButton>
            <span className="text-sm text-slate-600">
              Runs in one transaction{p.counts.error ? `; the ${p.counts.error} row${p.counts.error === 1 ? "" : "s"} with errors are skipped` : ""}.
            </span>
          </ActionForm>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card title="Columns">
          <ul className="space-y-1.5 text-sm">
            {p.columns.map((c) => (
              <li key={c.index} className="flex items-start justify-between gap-2">
                <span className="truncate font-mono text-xs" title={c.header}>{c.header || `(column ${c.index + 1})`}</span>
                {c.target.kind === "field" ? (
                  <Badge tone="blue">{FIELD_LABELS[c.target.field] ?? c.target.field}</Badge>
                ) : c.target.kind === "attribute" ? (
                  <Badge tone="purple">attribute {c.target.key}</Badge>
                ) : (
                  <Badge title={c.target.reason}>ignored</Badge>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card title={`First ${Math.min(PREVIEW_ROWS, p.rows.length)} rows`} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Action</th>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Class</th>
                  <th>Status</th>
                  <th>Owner</th>
                  <th>Serial</th>
                  <th>Attributes</th>
                </tr>
              </thead>
              <tbody>
                {p.rows.slice(0, PREVIEW_ROWS).map((r) => (
                  <tr key={r.line} className={r.errors.length ? "bg-red-50/50" : undefined}>
                    <td className="text-xs text-slate-500">{r.line}</td>
                    <td>
                      {r.action === "create" ? <Badge tone="green">new</Badge> : r.action === "update" ? <Badge tone="blue">update</Badge> : <Badge tone="red">error</Badge>}
                    </td>
                    <td className="font-mono text-xs">{r.code || "—"}</td>
                    <td className="max-w-48 truncate">{r.values?.name ?? (r.action === "update" ? <span className="text-slate-400">unchanged</span> : r.code)}</td>
                    <td className="text-slate-600">{r.className ?? "—"}</td>
                    <td className="text-slate-600">{r.values?.status ? CI_STATUS_LABELS[r.values.status] : "—"}</td>
                    <td className="text-xs text-slate-600">{r.values?.owner_email ?? "—"}</td>
                    <td className="font-mono text-xs">{r.values?.serial_no ?? "—"}</td>
                    <td className="max-w-64 text-xs text-slate-500">
                      {Object.entries(r.rawAttributes)
                        .slice(0, 6)
                        .map(([k, v]) => `${k}: ${v.length > 30 ? v.slice(0, 30) + "…" : v}`)
                        .join(" · ") || "—"}
                      {r.errors.length > 0 && <div className="mt-1 text-red-700">{r.errors.join("; ")}</div>}
                      {r.warnings.length > 0 && <div className="mt-1 text-amber-700">{r.warnings.join("; ")}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {errorRows.length > 0 && (
        <Card title={`Rows with errors (${errorRows.length})`} className="mt-4">
          <IssueList items={errorRows.slice(0, MAX_LISTED).map((r) => ({ line: r.line, message: r.errors.join("; ") }))} tone="red" />
          {errorRows.length > MAX_LISTED && <p className="hint">…and {errorRows.length - MAX_LISTED} more.</p>}
        </Card>
      )}
      {warningRows.length > 0 && (
        <Card title={`Warnings (${warningRows.length})`} className="mt-4">
          <IssueList items={warningRows.slice(0, MAX_LISTED).map((r) => ({ line: r.line, message: r.warnings.join("; ") }))} tone="amber" />
          {warningRows.length > MAX_LISTED && <p className="hint">…and {warningRows.length - MAX_LISTED} more.</p>}
        </Card>
      )}
    </>
  )
}

function IssueList({ items, tone }: { items: { line: number; message: string }[]; tone: "red" | "amber" }) {
  return (
    <ul className="space-y-1 text-sm">
      {items.map((i, n) => (
        <li key={n} className="flex gap-3">
          <span className="w-16 shrink-0 text-xs text-slate-500">Line {i.line}</span>
          <span className={tone === "red" ? "text-red-700" : "text-amber-800"}>{i.message}</span>
        </li>
      ))}
    </ul>
  )
}
