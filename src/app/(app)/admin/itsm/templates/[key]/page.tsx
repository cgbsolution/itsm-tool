import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { config } from "@/lib/config"
import { getTemplateAdmin, sampleVars } from "@/lib/admin/templates"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, PageHeader } from "@/components/ui"
import { ItsmTabs } from "../../tabs"
import { TemplateEditor } from "./editor"
import { resetTemplateAction, saveTemplateAction } from "../../actions"

export const metadata = { title: "Edit email template" }

export default async function TemplatePage({ params }: { params: Promise<{ key: string }> }) {
  const actor = await requirePermission("admin.itsm")
  const { key: raw } = await params
  let key = raw
  try {
    key = decodeURIComponent(raw)
  } catch {
    notFound()
  }
  let t
  try {
    t = await getTemplateAdmin(actor, key)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const current = t.override ?? t.def
  const brand = { name: actor.tenant.brandName, color: actor.tenant.brandColor }
  return (
    <>
      <PageHeader
        title={<span className="font-mono">{t.key}</span>}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {t.def.description}
            {t.override ? (
              <Badge tone="blue">Customised {formatDateTime(t.override.updated_at, actor.tenant.timezone)}</Badge>
            ) : (
              <Badge>Default text</Badge>
            )}
          </span>
        }
        back={{ href: "/admin/itsm/templates", label: "Email templates" }}
      />
      <ItsmTabs active="templates" />
      <Card>
        <ActionForm action={saveTemplateAction.bind(null, t.key)} className="space-y-3">
          <TemplateEditor
            key={t.override ? String(new Date(t.override.updated_at).getTime()) : "default"}
            initialSubject={current.subject}
            initialBody={current.body}
            placeholders={t.placeholders}
            sample={sampleVars(config.appUrl(), brand.name, actor.name)}
            brand={brand}
          />
          <SubmitButton>Save template</SubmitButton>
        </ActionForm>
      </Card>
      {t.override && (
        <Card title="Reset to default" className="mt-4">
          <p className="mb-3 text-sm text-slate-500">Deletes the customised text. Emails go back to the built-in wording.</p>
          <ActionForm action={resetTemplateAction.bind(null, t.key)} confirm="Discard the customised text and use the default?">
            <SubmitButton className="btn btn-danger">Reset to default</SubmitButton>
          </ActionForm>
        </Card>
      )}
    </>
  )
}
