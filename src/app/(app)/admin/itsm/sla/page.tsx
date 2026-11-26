import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listSlaPolicies, type AdminSlaPolicy } from "@/lib/admin/sla"
import { groupOptions } from "@/lib/admin/groups"
import { formatMinutes } from "@/lib/itsm/clock"
import { TICKET_TYPE_LABELS } from "@/lib/itsm/vocab"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, EmptyState, PageHeader, PriorityBadge } from "@/components/ui"
import { ItsmTabs } from "../tabs"
import { Note } from "../parts"
import { SlaFields } from "./form"
import { createSlaAction } from "../actions"

export const metadata = { title: "SLA & OLA policies" }

function PolicyTable({ rows, ola }: { rows: AdminSlaPolicy[]; ola: boolean }) {
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            {ola && <th>Group</th>}
            <th>Record type</th>
            <th>Priority</th>
            <th>Response</th>
            <th>Resolution</th>
            <th>Clock</th>
            <th>Warn at</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className={p.is_active ? "" : "opacity-60"}>
              {ola && <td className="font-medium">{p.group_name ?? "—"}</td>}
              <td>{p.ticket_type ? TICKET_TYPE_LABELS[p.ticket_type] : <span className="text-slate-500">All types</span>}</td>
              <td>
                <PriorityBadge priority={p.priority} />
              </td>
              <td className="whitespace-nowrap">{formatMinutes(p.response_minutes)}</td>
              <td className="whitespace-nowrap">{formatMinutes(p.resolution_minutes)}</td>
              <td className="text-xs text-slate-600">{p.business_hours ? "Business hours" : "24 × 7"}</td>
              <td className="text-xs text-slate-600">{p.warn_percent}%</td>
              <td>{p.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
              <td className="text-right">
                <Link href={`/admin/itsm/sla/${p.id}`} className="btn btn-sm">
                  Edit
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function SlaPage() {
  const actor = await requirePermission("admin.itsm")
  const [policies, groups] = await Promise.all([listSlaPolicies(actor), groupOptions(actor)])
  const sla = policies.filter((p) => p.kind === "sla")
  const ola = policies.filter((p) => p.kind === "ola")
  const supportGroups = groups.filter((g) => g.kind === "support" || g.kind === "other")
  return (
    <>
      <PageHeader title="ITSM settings" subtitle="Service level (SLA) and operational level (OLA) targets" back={{ href: "/admin/itsm", label: "ITSM settings" }} />
      <ItsmTabs active="sla" />
      <Note>
        Changes apply to SLA clocks that start after you save. Tickets already running keep the targets they started with. A policy for a specific record type wins over the
        “All types” policy of the same priority.
      </Note>

      <section className="mb-8 space-y-3">
        <h2>SLA policies</h2>
        <p className="text-sm text-slate-500">Customer-facing targets. Each ticket gets the policy for its record type and priority.</p>
        {sla.length === 0 ? <EmptyState title="No SLA policies">Tickets get no SLA targets until you add one.</EmptyState> : <PolicyTable rows={sla} ola={false} />}
        <details className="card">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Add an SLA policy</summary>
          <div className="border-t border-slate-100 p-4">
            <ActionForm action={createSlaAction} className="space-y-3">
              <SlaFields kind="sla" groups={groups} />
              <SubmitButton>Add SLA policy</SubmitButton>
            </ActionForm>
          </div>
        </details>
      </section>

      <section className="space-y-3">
        <h2>OLA policies</h2>
        <p className="text-sm text-slate-500">Internal targets for a support group, measured from when the group receives the ticket.</p>
        {ola.length === 0 ? <EmptyState title="No OLA policies">Add one to track how fast each support group responds and resolves.</EmptyState> : <PolicyTable rows={ola} ola />}
        <details className="card">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Add an OLA policy</summary>
          <div className="border-t border-slate-100 p-4">
            {groups.length === 0 ? (
              <p className="text-sm text-slate-500">
                Create a <Link href="/admin/groups">support group</Link> first.
              </p>
            ) : (
              <ActionForm action={createSlaAction} className="space-y-3">
                <SlaFields kind="ola" groups={supportGroups.length ? supportGroups : groups} />
                <SubmitButton>Add OLA policy</SubmitButton>
              </ActionForm>
            )}
          </div>
        </details>
      </section>
      <Card className="mt-6" title="Working calendar">
        <p className="text-sm text-slate-600">
          Policies that count business hours only use the tenant&apos;s <Link href="/admin/itsm/calendar">working calendar</Link> (time zone, work days, hours and holidays).
        </p>
      </Card>
    </>
  )
}
