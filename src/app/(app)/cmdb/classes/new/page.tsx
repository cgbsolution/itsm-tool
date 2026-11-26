import { requirePermission } from "@/lib/auth/session"
import { PageHeader } from "@/components/ui"
import { ClassForm } from "../class-form"

export const metadata = { title: "New CI class" }

export default async function NewClassPage() {
  await requirePermission("admin.itsm")
  return (
    <>
      <PageHeader title="New CI class" back={{ href: "/cmdb/classes", label: "CI classes" }} />
      <ClassForm />
    </>
  )
}
