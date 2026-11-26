import Link from "next/link"
import { requirePermission } from "@/lib/auth/session"
import { listTemplatesAdmin } from "@/lib/admin/templates"
import { Badge, PageHeader, When } from "@/components/ui"
import { ItsmTabs } from "../tabs"

export const metadata = { title: "Email templates" }

export default async function TemplatesPage() {
  const actor = await requirePermission("admin.itsm")
  const rows = await listTemplatesAdmin(actor)
  const tz = actor.tenant.timezone
  return (
    <>
      <PageHeader title="ITSM settings" subtitle="The wording of the emails this tenant sends" back={{ href: "/admin/itsm", label: "ITSM settings" }} />
      <ItsmTabs active="templates" />
      <p className="hint mb-4">
        Templates are plain text with {"{{placeholders}}"}. The tenant&apos;s brand name and colour are added on sending. A customised template replaces the default until you
        reset it.
      </p>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Template</th>
              <th>Sent</th>
              <th>Text</th>
              <th>Changed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.key}>
                <td>
                  <Link href={`/admin/itsm/templates/${encodeURIComponent(t.key)}`} className="font-mono text-xs font-medium">
                    {t.key}
                  </Link>
                </td>
                <td className="text-slate-600">{t.description}</td>
                <td>{t.overridden ? <Badge tone="blue">Customised</Badge> : <Badge>Default</Badge>}</td>
                <td className="text-xs text-slate-500">{t.overridden ? <When value={t.updated_at} timeZone={tz} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
