import { requirePermission } from "@/lib/auth/session"
import { getMatrix } from "@/lib/admin/itsm"
import { IMPACT_LABELS, LEVELS, PRIORITIES, PRIORITY_LABELS, URGENCY_LABELS, priorityFromMatrix } from "@/lib/itsm/vocab"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../tabs"
import { saveMatrixAction } from "../actions"

export const metadata = { title: "Priority matrix" }

const CELL_TONE: Record<string, string> = {
  critical: "bg-red-50",
  high: "bg-amber-50",
  medium: "bg-blue-50",
  low: "bg-slate-50",
}

export default async function PriorityPage() {
  const actor = await requirePermission("admin.itsm")
  const matrix = await getMatrix(actor)
  const levels = [...LEVELS].reverse() // high, medium, low
  return (
    <>
      <PageHeader title="ITSM settings" subtitle="Priority from impact × urgency" back={{ href: "/admin/itsm", label: "ITSM settings" }} />
      <ItsmTabs active="priority" />
      <Card className="max-w-4xl">
        <p className="mb-4 text-sm text-slate-600">
          When someone sets impact and urgency on a ticket, its priority comes from this matrix. IT staff may still override the priority on a ticket. Changes apply to tickets
          raised or re-prioritised from now on; the SLA targets follow the priority.
        </p>
        <ActionForm action={saveMatrixAction} className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="p-2 text-left text-xs font-semibold text-slate-500 uppercase">Impact ↓ · Urgency →</th>
                  {levels.map((u) => (
                    <th key={u} className="p-2 text-left text-xs font-semibold text-slate-700">
                      {URGENCY_LABELS[u]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {levels.map((i) => (
                  <tr key={i}>
                    <th className="p-2 text-left align-middle text-xs font-semibold text-slate-700">{IMPACT_LABELS[i]}</th>
                    {levels.map((u) => {
                      const p = priorityFromMatrix(matrix, i, u)
                      return (
                        <td key={u} className={`border border-slate-200 p-2 ${CELL_TONE[p]}`}>
                          <select name={`${i}.${u}`} defaultValue={p} className="input" aria-label={`Priority for impact ${i}, urgency ${u}`}>
                            {[...PRIORITIES].reverse().map((x) => (
                              <option key={x} value={x}>
                                {PRIORITY_LABELS[x]}
                              </option>
                            ))}
                          </select>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SubmitButton>Save matrix</SubmitButton>
        </ActionForm>
      </Card>
    </>
  )
}
