import { requirePermission } from "@/lib/auth/session"
import { deadJobs, systemInfo } from "@/lib/sysadmin/system"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, KeyValues, PageHeader, When, type Tone } from "@/components/ui"
import { bytes, formatDateTime } from "@/lib/format"
import { retryJobAction } from "./actions"

export const metadata = { title: "System" }

const JOB_TONE: Record<string, Tone> = { queued: "blue", running: "purple", done: "green", dead: "red" }
const JOB_STATUSES = ["queued", "running", "done", "dead"] as const

export default async function SystemPage() {
  const actor = await requirePermission("admin.settings")
  const [info, dead] = await Promise.all([systemInfo(actor), deadJobs(actor)])
  const tz = actor.tenant.timezone
  const kinds = [...new Set(info.jobs.map((j) => j.kind))].sort()
  const jobCount = (kind: string, status: string) => info.jobs.find((j) => j.kind === kind && j.status === status)?.n ?? 0
  return (
    <>
      <PageHeader title="System" subtitle="Versions, database migrations, background jobs and storage" back={{ href: "/admin", label: "Administration" }} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Versions">
          <KeyValues
            items={[
              ["Application", <code key="a">{info.appVersion}</code>],
              ["Node.js", <code key="n">{info.nodeVersion}</code>],
              ["Database", <span key="d" className="text-xs break-words">{info.dbVersion}</span>],
            ]}
          />
        </Card>
        <Card title="Database migrations">
          {info.pending.length > 0 ? (
            <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-sm text-amber-900 ring-1 ring-amber-200">
              {info.pending.length} pending: {info.pending.join(", ")}. They are applied at the next start (or with <code>npm run db:migrate</code>).
            </p>
          ) : (
            <p className="mb-2 text-sm text-emerald-700">The schema is up to date.</p>
          )}
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {info.migrations.map((m) => (
              <li key={m.version} className="flex justify-between gap-2">
                <code>{m.version}</code>
                <span className="text-slate-500">{formatDateTime(m.applied_at, tz)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Storage and email">
          <KeyValues
            items={[
              ["Storage directory", <code key="s" className="text-xs break-all">{info.storageDir}</code>],
              ["This tenant's files", `${info.files.count} files, ${bytes(info.files.bytes)}`],
              [
                "Email outbox",
                info.outbox.length ? (
                  <span key="o" className="flex flex-wrap gap-1">
                    {info.outbox.map((o) => (
                      <Badge key={o.status} tone={o.status === "failed" ? "red" : o.status === "sent" ? "green" : o.status === "skipped" ? "amber" : "blue"}>
                        {o.status}: {o.n}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "Empty"
                ),
              ],
            ]}
          />
        </Card>
      </div>

      <h2 className="mt-8 mb-3">Job queue</h2>
      <p className="mb-2 text-xs text-slate-500">All background jobs on this installation: active and dead jobs, and everything from the last 7 days.</p>
      {kinds.length === 0 ? (
        <EmptyState title="No jobs" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Kind</th>
                {JOB_STATUSES.map((s) => (
                  <th key={s} className="text-right">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr key={k}>
                  <td className="font-mono text-xs">{k}</td>
                  {JOB_STATUSES.map((s) => {
                    const n = jobCount(k, s)
                    return (
                      <td key={s} className="text-right tabular-nums">
                        {n ? <Badge tone={JOB_TONE[s]}>{n}</Badge> : <span className="text-slate-300">0</span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-8 mb-3">Dead jobs</h2>
      <p className="mb-2 text-xs text-slate-500">
        Jobs that failed every attempt (latest 50{actor.isSuperadmin ? ", all tenants" : ", this tenant's"}). Retrying runs them again from the first attempt.
      </p>
      {dead.length === 0 ? (
        <EmptyState title="No dead jobs" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Kind</th>
                <th>Attempts</th>
                <th>Error</th>
                <th>Failed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dead.map((j) => (
                <tr key={j.id}>
                  <td className="font-mono text-xs">{j.id}</td>
                  <td className="font-mono text-xs">
                    {j.kind}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-slate-400">payload</summary>
                      <pre className="mt-1 max-w-xs overflow-x-auto rounded bg-slate-50 p-2 text-[11px]">{JSON.stringify(j.payload, null, 2)}</pre>
                    </details>
                  </td>
                  <td className="tabular-nums">
                    {j.attempts} / {j.max_attempts}
                  </td>
                  <td className="max-w-md text-xs break-words text-red-700">{j.last_error ?? ""}</td>
                  <td className="text-xs whitespace-nowrap text-slate-500">
                    <When value={j.finished_at ?? j.created_at} timeZone={tz} />
                  </td>
                  <td>
                    <ActionForm action={retryJobAction.bind(null, j.id)}>
                      <SubmitButton className="btn btn-sm">Retry</SubmitButton>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
