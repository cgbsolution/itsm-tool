import Link from "next/link"
import { requirePermission, can } from "@/lib/auth/session"
import { listDeviceGroups, listPolicies, patchMaintenanceWindows } from "@/lib/endpoints/queries"
import { REBOOT_LABELS, WEEKDAY_LABELS, type RebootBehavior } from "@/lib/endpoints/vocab"
import { nextSlot } from "@/lib/endpoints/planning"
import { humanize } from "@/lib/itsm/vocab"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, PageHeader, When } from "@/components/ui"
import { PolicyFields } from "./form"
import { createPolicyAction } from "../actions"

export const metadata = { title: "Patch policies" }

export default async function PoliciesPage() {
  const actor = await requirePermission("patch.deploy")
  const tz = actor.tenant.timezone
  const [policies, groups, windows] = await Promise.all([listPolicies(actor.tenantId), listDeviceGroups(actor.tenantId), patchMaintenanceWindows(actor.tenantId)])
  const now = new Date()

  return (
    <>
      <PageHeader back={{ href: "/patches", label: "Patches" }} title="Patch policies" subtitle="Auto-approval rules and automatic deployment schedules per device group" />
      <div className="space-y-4">
        {policies.length === 0 ? (
          <EmptyState title="No policies yet">Create one below, for example: auto-approve security updates for Pilot after 0 days and deploy them every Tuesday at 02:00.</EmptyState>
        ) : (
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Applies to</th>
                  <th>Auto-approve</th>
                  <th>Schedule</th>
                  <th>Last run</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => {
                  const next = p.is_active ? nextSlot(p.schedule_days, p.schedule_time, tz, now) : null
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/patches/policies/${p.id}`} className="font-medium">{p.name}</Link>
                        {!p.is_active && <> <Badge>Inactive</Badge></>}
                        {p.description && <div className="text-xs text-slate-500">{p.description}</div>}
                      </td>
                      <td className="text-slate-600">{p.group_name ?? "Every device"}</td>
                      <td className="text-slate-600">
                        {p.auto_approve_classifications.length ? (
                          <>
                            {p.auto_approve_classifications.map(humanize).join(", ")}
                            <div className="text-xs text-slate-500">after {p.auto_approve_delay_days} day{p.auto_approve_delay_days === 1 ? "" : "s"}</div>
                          </>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="text-slate-600">
                        {p.schedule_days.length ? (
                          <>
                            {p.schedule_days.length === 7 ? "Daily" : p.schedule_days.map((d) => WEEKDAY_LABELS[d]).join(", ")} at {p.schedule_time}
                            <div className="text-xs text-slate-500">
                              {p.maintenance_window_name ? `then in ${p.maintenance_window_name} · ` : ""}
                              {REBOOT_LABELS[p.reboot_behavior as RebootBehavior]}
                              {next ? ` · next ${formatDateTime(next, tz)}` : ""}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-400">No automatic deployment</span>
                        )}
                      </td>
                      <td className="text-xs whitespace-nowrap text-slate-500"><When value={p.last_run_at} timeZone={tz} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <Card title="New policy">
          <ActionForm action={createPolicyAction} className="space-y-4">
            <PolicyFields groups={groups} windows={windows} canApprove={can(actor, "patch.approve")} tz={tz} />
            <SubmitButton>Create policy</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  )
}
