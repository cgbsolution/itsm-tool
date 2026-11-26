import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getWindow } from "@/lib/admin/windows"
import { occurrences } from "@/lib/itsm/windows"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../../tabs"
import { WindowFields } from "../form"
import { deleteWindowAction, updateWindowAction } from "../../actions"

export const metadata = { title: "Edit window" }

export default async function WindowPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.itsm")
  const { id } = await params
  let w
  try {
    w = await getWindow(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const tz = actor.tenant.timezone
  const now = new Date()
  const next = occurrences(w, now, new Date(now.getTime() + 3 * 366 * 86_400_000), 5)
  return (
    <>
      <PageHeader title={`Edit: ${w.name}`} back={{ href: "/admin/itsm/windows", label: "Maintenance windows" }} />
      <ItsmTabs active="windows" />
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          <ActionForm action={updateWindowAction.bind(null, w.id)} className="space-y-3">
            <WindowFields w={w} timeZone={tz} />
            <SubmitButton>Save window</SubmitButton>
          </ActionForm>
        </Card>
        <div className="space-y-4">
          <Card title="Next occurrences">
            {next.length === 0 ? (
              <p className="text-sm text-slate-500">None upcoming</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {next.map((o) => (
                  <li key={o.start.toISOString()}>
                    {formatDateTime(o.start, tz)}
                    <span className="block text-xs text-slate-500">until {formatDateTime(o.end, tz)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Delete">
            <p className="mb-3 text-sm text-slate-500">Patch deployments planned for this window are no longer tied to it.</p>
            <ActionForm action={deleteWindowAction.bind(null, w.id)} confirm={`Delete ${w.name}?`}>
              <SubmitButton className="btn btn-danger">Delete window</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  )
}
