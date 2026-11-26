/** Server-rendered pieces shared by the endpoint and deployment pages. */
import Link from "next/link"
import type { AgentJobRow } from "@/lib/endpoints/queries"
import { JOB_KIND_LABELS, jobTone, type JobKind } from "@/lib/endpoints/vocab"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, When } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { cancelJobAction } from "./actions"

function jobSummary(j: AgentJobRow): string {
  const p = j.payload ?? {}
  if (j.kind === "install_patches") {
    const n = Array.isArray(p.patches) ? p.patches.length : 0
    return `${n} patch${n === 1 ? "" : "es"} · reboot: ${String(p.reboot ?? "if_required").replace("_", " ")}`
  }
  if (j.kind === "run_script") return `${String(p.shell ?? "")} · ${String(p.script ?? "").split(/\r?\n/)[0].slice(0, 80)}`
  if (j.kind === "reboot") return `in ${Number(p.delay_seconds ?? 0)} s`
  return ""
}

/** Agent jobs with status; each expands to show its script, patches, output and result. */
export function JobList({ jobs, tz, deviceId, canCancel, showDevice }: { jobs: (AgentJobRow & { hostname?: string; device_id?: string })[]; tz: string; deviceId?: string; canCancel: boolean; showDevice?: boolean }) {
  if (!jobs.length) return <p className="text-sm text-slate-500">No jobs yet.</p>
  return (
    <ul className="divide-y divide-slate-100">
      {jobs.map((j) => (
        <li key={j.id} className="py-2">
          <details>
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm">
              <Badge tone={jobTone(j.status)}>{j.status}</Badge>
              {showDevice && j.device_id ? (
                <Link href={`/endpoints/${j.device_id}?tab=jobs`} className="font-medium">{j.hostname}</Link>
              ) : (
                <span className="font-medium">{JOB_KIND_LABELS[j.kind as JobKind] ?? j.kind}</span>
              )}
              <span className="text-xs text-slate-500">{jobSummary(j)}</span>
              {j.deployment_name && j.deployment_id && (
                <Link href={`/patches/deployments/${j.deployment_id}`} className="text-xs">{j.deployment_name}</Link>
              )}
              <span className="ml-auto flex items-center gap-2 text-xs text-slate-400">
                {j.exit_code !== null && <span className="font-mono">exit {j.exit_code}</span>}
                <When value={j.finished_at ?? j.started_at ?? j.dispatched_at ?? j.created_at} timeZone={tz} />
              </span>
            </summary>
            <div className="mt-2 space-y-2 pl-1 text-xs text-slate-600">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>Queued {formatDateTime(j.created_at, tz)}{j.created_by_name ? ` by ${j.created_by_name}` : ""}</span>
                {j.dispatched_at && <span>Picked up {formatDateTime(j.dispatched_at, tz)}</span>}
                {j.started_at && <span>Started {formatDateTime(j.started_at, tz)}</span>}
                {j.finished_at && <span>Finished {formatDateTime(j.finished_at, tz)}</span>}
                {j.status === "queued" && j.expires_at && <span>Expires {formatDateTime(j.expires_at, tz)}</span>}
              </div>
              {j.kind === "run_script" && typeof j.payload?.script === "string" && (
                <div>
                  <div className="mb-1 font-medium text-slate-500">Script</div>
                  <pre className="max-h-64 overflow-auto rounded bg-slate-50 p-2 font-mono whitespace-pre-wrap ring-1 ring-slate-200">{j.payload.script}</pre>
                </div>
              )}
              {j.kind === "install_patches" && Array.isArray(j.payload?.patches) && (
                <ul className="list-inside list-disc">
                  {(j.payload.patches as { patch_id: string; title: string; kb?: string | null }[]).map((p) => (
                    <li key={p.patch_id}>
                      <Link href={`/patches/${p.patch_id}`}>{p.kb ? `${p.kb} · ` : ""}{p.title}</Link>
                    </li>
                  ))}
                </ul>
              )}
              {j.output ? (
                <div>
                  <div className="mb-1 font-medium text-slate-500">Output</div>
                  <pre className="max-h-96 overflow-auto rounded bg-slate-900 p-2 font-mono whitespace-pre-wrap text-slate-100">{j.output}</pre>
                </div>
              ) : (
                j.finished_at && <p className="text-slate-400">No output.</p>
              )}
              {j.result && Object.keys(j.result).length > 0 && (
                <div>
                  <div className="mb-1 font-medium text-slate-500">Result</div>
                  <pre className="max-h-64 overflow-auto rounded bg-slate-50 p-2 font-mono whitespace-pre-wrap ring-1 ring-slate-200">{JSON.stringify(j.result, null, 2)}</pre>
                </div>
              )}
              {canCancel && deviceId && (j.status === "queued" || j.status === "dispatched") && (
                <ActionForm action={cancelJobAction.bind(null, deviceId, j.id)} confirm="Cancel this job?">
                  <SubmitButton className="btn btn-sm">Cancel job</SubmitButton>
                </ActionForm>
              )}
            </div>
          </details>
        </li>
      ))}
    </ul>
  )
}

