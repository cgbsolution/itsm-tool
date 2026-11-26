import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission, can } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getDeployment } from "@/lib/endpoints/queries"
import { JOB_STATUSES, REBOOT_LABELS, approvalTone, deploymentTone, jobTone, severityTone, type RebootBehavior } from "@/lib/endpoints/vocab"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, KeyValues, PageHeader } from "@/components/ui"
import { JobList } from "../../../endpoints/components"
import { cancelDeploymentAction } from "../../actions"

export const metadata = { title: "Patch deployment" }

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("endpoint.view")
  const { id } = await params
  let data
  try {
    data = await getDeployment(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const { deployment: d, patches, groups, devices, jobs } = data
  const tz = actor.tenant.timezone
  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, jobs.filter((j) => j.status === s).length])) as Record<string, number>
  const done = counts.succeeded + counts.failed + counts.cancelled + counts.expired
  const pct = jobs.length ? Math.round((done / jobs.length) * 100) : d.status === "completed" ? 100 : 0
  const open = ["draft", "scheduled", "running"].includes(d.status)

  return (
    <>
      <PageHeader
        back={{ href: "/patches/deployments", label: "Deployments" }}
        title={d.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={deploymentTone(d.status)}>{d.status}</Badge>
            <span className="text-xs">Created {formatDateTime(d.created_at, tz)}{d.created_by_name ? ` by ${d.created_by_name}` : d.policy_name ? ` by policy ${d.policy_name}` : ""}</span>
          </span>
        }
        actions={
          can(actor, "patch.deploy") && open ? (
            <ActionForm action={cancelDeploymentAction.bind(null, d.id)} confirm="Cancel this deployment? Jobs that have not started are cancelled; running installs finish.">
              <SubmitButton className="btn btn-danger">Cancel deployment</SubmitButton>
            </ActionForm>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Progress">
            {jobs.length === 0 ? (
              <p className="text-sm text-slate-500">
                {d.status === "scheduled"
                  ? `Not started yet. ${d.maintenance_window_name ? `Starts in the maintenance window ${d.maintenance_window_name}` : "Starts"}${d.scheduled_at ? ` at ${formatDateTime(d.scheduled_at, tz)}` : ""}.`
                  : d.status === "completed"
                    ? "No target device was missing these patches."
                    : "No device jobs."}
              </p>
            ) : (
              <>
                <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
                  <div className={`h-full ${counts.failed + counts.expired ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-sm">
                  <span className="text-slate-600">{done} of {jobs.length} devices finished</span>
                  {JOB_STATUSES.filter((s) => counts[s] > 0).map((s) => (
                    <Badge key={s} tone={jobTone(s)}>{counts[s]} {s}</Badge>
                  ))}
                </div>
              </>
            )}
          </Card>
          <Card title={`Devices (${jobs.length})`}>
            <JobList jobs={jobs} tz={tz} canCancel={false} showDevice />
          </Card>
        </div>

        <aside className="space-y-4">
          <Card title="Details">
            <KeyValues
              items={[
                ["Schedule", d.maintenance_window_name ? `Maintenance window ${d.maintenance_window_name}` : d.scheduled_at ? formatDateTime(d.scheduled_at, tz) : "Immediately"],
                ["Started", d.started_at ? formatDateTime(d.started_at, tz) : null],
                ["Finished", d.completed_at ? formatDateTime(d.completed_at, tz) : null],
                ["Reboot", REBOOT_LABELS[d.reboot_behavior as RebootBehavior] ?? d.reboot_behavior],
                ["Change", d.change_number ? <Link key="c" href={`/tickets/${d.change_number}`}>{d.change_number}{d.change_subject ? ` · ${d.change_subject}` : ""}</Link> : null],
                ["Policy", d.policy_name ? <Link key="p" href={`/patches/policies/${d.policy_id}`}>{d.policy_name}</Link> : null],
                ["Groups", groups.length ? groups.map((g) => `${g.name} (ring ${g.ring})`).join(", ") : null],
                ["Devices", devices.length ? devices.map((x) => x.hostname).join(", ") : null],
                ["Description", d.description ? <span key="d" className="prose-plain">{d.description}</span> : null],
              ]}
            />
          </Card>
          <Card title={`Patches (${patches.length})`}>
            <ul className="space-y-1.5 text-sm">
              {patches.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-2">
                  <Link href={`/patches/${p.id}`} className="min-w-0">{p.kb ? `${p.kb} · ` : ""}{p.title}</Link>
                  <span className="flex shrink-0 gap-1">
                    <Badge tone={severityTone(p.severity)}>{p.severity}</Badge>
                    {p.approval !== "approved" && <Badge tone={approvalTone(p.approval)}>{p.approval}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  )
}
