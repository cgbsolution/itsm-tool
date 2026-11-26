import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { ciFormOptions, getCiDetail, getClass, listClasses } from "@/lib/cmdb/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { PageHeader } from "@/components/ui"
import { updateCiAction } from "../../actions"
import { CiFields } from "../../ui"

export const metadata = { title: "Edit configuration item" }

export default async function EditCiPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ class?: string }> }) {
  const actor = await requirePermission("cmdb.edit")
  const { id } = await params
  const sp = await searchParams
  let d
  try {
    d = await getCiDetail(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const ci = d.ci
  // ?class=<key> switches the form to another class (its attributes are shown)
  const other = sp.class && sp.class !== ci.class_key ? await getClass(actor, sp.class) : null
  const cls = other && other.is_active ? other : null
  const schema = cls ? cls.attributes : d.schema
  const [options, classes] = await Promise.all([ciFormOptions(actor.tenantId), listClasses(actor, { activeOnly: true })])

  return (
    <>
      <PageHeader title={`Edit ${ci.ci_code}`} back={{ href: `/cmdb/${ci.id}`, label: ci.ci_code }} />
      <form method="get" className="card mb-4 flex flex-wrap items-center gap-2 p-3 text-sm">
        <span className="text-slate-600">Class:</span>
        <select name="class" className="input w-auto" defaultValue={cls?.key ?? ci.class_key} aria-label="Class">
          {!ci.class_active && <option value={ci.class_key}>{ci.class_name} (inactive)</option>}
          {classes.map((c) => (
            <option key={c.id} value={c.key}>{c.name}</option>
          ))}
        </select>
        <button className="btn btn-sm">Change class</button>
        {cls && (
          <span className="text-amber-700">
            Saving moves this item from {ci.class_name} to {cls.name}. <Link href={`/cmdb/${ci.id}/edit`}>Keep {ci.class_name}</Link>
          </span>
        )}
      </form>
      <ActionForm action={updateCiAction.bind(null, ci.id)} className="max-w-5xl space-y-4">
        <input type="hidden" name="classId" value={cls?.id ?? ci.class_id} />
        <CiFields schema={schema} defaults={ci} {...options} />
        <div className="flex gap-2">
          <SubmitButton pendingText="Saving…">Save changes</SubmitButton>
          <Link className="btn" href={`/cmdb/${ci.id}`}>Cancel</Link>
        </div>
      </ActionForm>
    </>
  )
}
