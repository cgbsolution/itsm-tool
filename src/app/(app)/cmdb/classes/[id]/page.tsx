import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { isUuid } from "@/lib/db"
import { getClass } from "@/lib/cmdb/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, PageHeader } from "@/components/ui"
import { deleteClassAction } from "../../actions"
import { ClassForm } from "../class-form"

export const metadata = { title: "Edit CI class" }

export default async function EditClassPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.itsm")
  const { id } = await params
  if (!isUuid(id)) notFound()
  const cls = await getClass(actor, id)
  if (!cls) notFound()
  return (
    <>
      <PageHeader
        title={`Edit ${cls.name}`}
        subtitle={
          <>
            {cls.ci_count} item{cls.ci_count === 1 ? "" : "s"} use this class{cls.ci_count > 0 && <> · <Link href={`/cmdb?class=${cls.key}`}>view them</Link></>}
          </>
        }
        back={{ href: "/cmdb/classes", label: "CI classes" }}
      />
      <ClassForm cls={cls} />
      <Card title="Delete" className="mt-6 max-w-5xl">
        {cls.ci_count > 0 ? (
          <p className="text-sm text-slate-600">A class that is in use cannot be deleted. Untick “Active” above to stop it being used for new items.</p>
        ) : (
          <ActionForm action={deleteClassAction.bind(null, cls.id)} confirm={`Delete the class ${cls.name}?`}>
            <SubmitButton className="btn btn-danger">Delete class</SubmitButton>
          </ActionForm>
        )}
      </Card>
    </>
  )
}
