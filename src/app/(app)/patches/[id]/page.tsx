import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePermission, can } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getPatch, patchDevices } from "@/lib/endpoints/queries"
import { OS_LABELS, SOURCE_LABELS, approvalTone, patchStateTone, safeHttpUrl, severityTone, type OsFamily } from "@/lib/endpoints/vocab"
import { humanize } from "@/lib/itsm/vocab"
import { bytes, formatDate, formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, KeyValues, PageHeader, When } from "@/components/ui"
import { patchApprovalAction, removePackageAction } from "../actions"

export const metadata = { title: "Patch" }

type DeviceState = Awaited<ReturnType<typeof patchDevices>>[number]

function DeviceList({ rows, tz, showError }: { rows: DeviceState[]; tz: string; showError?: boolean }) {
  if (!rows.length) return <p className="text-sm text-slate-500">None.</p>
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {rows.map((d) => (
        <li key={d.device_id} className="flex flex-wrap items-start justify-between gap-2 py-1.5">
          <div className="min-w-0">
            <Link href={`/endpoints/${d.device_id}?tab=patches`} className="font-medium">{d.hostname}</Link>
            {d.group_name && <span className="text-xs text-slate-500"> · {d.group_name}</span>}
            {showError && d.last_error && <div className="text-xs text-red-700">{d.last_error}</div>}
          </div>
          <span className="text-xs text-slate-400">
            {d.installed_at ? <>installed <When value={d.installed_at} timeZone={tz} /></> : <>since <When value={d.detected_at} timeZone={tz} /></>}
          </span>
        </li>
      ))}
    </ul>
  )
}

export default async function PatchPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("endpoint.view")
  const { id } = await params
  let p
  try {
    p = await getPatch(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const tz = actor.tenant.timezone
  const devices = await patchDevices(actor, p.id)
  const missing = devices.filter((d) => d.state === "missing")
  const failed = devices.filter((d) => d.state === "failed")
  const pending = devices.filter((d) => d.state === "pending_reboot")
  const installed = devices.filter((d) => d.state === "installed")
  const approve = can(actor, "patch.approve")
  const support = safeHttpUrl(p.support_url)

  return (
    <>
      <PageHeader
        back={{ href: "/patches", label: "Patches" }}
        title={p.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {p.kb && <span className="font-mono text-xs">{p.kb}</span>}
            <Badge tone={severityTone(p.severity)}>{p.severity}</Badge>
            <Badge>{humanize(p.classification)}</Badge>
            <Badge tone={approvalTone(p.approval)}>{p.approval}</Badge>
            {p.reboot_required && <Badge tone="purple">Needs reboot</Badge>}
            {p.package_file_id && <Badge tone="blue">Offline package</Badge>}
          </span>
        }
        actions={
          can(actor, "patch.deploy") && p.approval === "approved" && missing.length + failed.length > 0 ? (
            <Link className="btn btn-primary" href={`/patches/deployments/new?patch=${p.id}`}>Deploy…</Link>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Details">
            <KeyValues
              items={[
                ["Operating system", OS_LABELS[p.os_family as OsFamily] ?? p.os_family],
                ["Source", SOURCE_LABELS[p.source] ?? p.source],
                ["Identifier", <span key="e" className="font-mono text-xs break-all">{p.external_id}</span>],
                ["Version", p.version],
                ["Released", p.release_date ? formatDate(p.release_date) : null],
                ["Size", p.size_bytes ? bytes(p.size_bytes) : null],
                ["First seen", formatDateTime(p.first_seen_at, tz)],
                ["More information", support ? <a key="u" href={support} target="_blank" rel="noopener noreferrer nofollow" className="break-all">{support}</a> : null],
                ["Description", p.description ? <span key="d" className="prose-plain">{p.description}</span> : null],
              ]}
            />
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card title={`Missing (${missing.length})`} className="scroll-mt-20" bodyClassName="max-h-[28rem] overflow-auto">
              <div id="missing" />
              <DeviceList rows={missing} tz={tz} />
            </Card>
            <Card title={`Failed (${failed.length})`} bodyClassName="max-h-[28rem] overflow-auto">
              <DeviceList rows={failed} tz={tz} showError />
            </Card>
            <Card title={`Installed (${installed.length + pending.length})`} bodyClassName="max-h-[28rem] overflow-auto">
              {pending.length > 0 && (
                <div className="mb-2">
                  <Badge tone={patchStateTone("pending_reboot")}>{pending.length} waiting for a reboot</Badge>
                </div>
              )}
              <DeviceList rows={[...pending, ...installed]} tz={tz} />
            </Card>
          </div>
        </div>

        <aside className="space-y-4">
          <Card title="Approval">
            <p className="mb-3 text-sm text-slate-600">
              {p.approval === "pending"
                ? "Not approved yet. Only approved patches are deployed."
                : `${humanize(p.approval)} ${p.approved_at ? formatDateTime(p.approved_at, tz) : ""} ${p.approved_by_name ? `by ${p.approved_by_name}` : p.approved_at ? "by a patch policy" : ""}`}
            </p>
            {approve && (
              <ActionForm action={patchApprovalAction.bind(null, p.id)} className="flex flex-wrap gap-2">
                {p.approval !== "approved" && <SubmitButton name="decision" value="approved" className="btn btn-primary">Approve</SubmitButton>}
                {p.approval !== "declined" && <SubmitButton name="decision" value="declined" className="btn">Decline</SubmitButton>}
                {p.approval !== "pending" && <SubmitButton name="decision" value="pending" className="btn btn-ghost">Reset to pending</SubmitButton>}
              </ActionForm>
            )}
          </Card>

          <Card title="Offline package">
            {p.package_file_id ? (
              <div className="space-y-2 text-sm">
                <KeyValues
                  items={[
                    ["File", <a key="f" href={`/api/files/${p.package_file_id}`}>{p.package_name}</a>],
                    ["Size", bytes(p.package_size)],
                    ["SHA-256", <span key="h" className="font-mono text-xs break-all">{p.package_sha256}</span>],
                    ["Uploaded", p.package_uploaded_at ? formatDateTime(p.package_uploaded_at, tz) : null],
                  ]}
                />
                <p className="hint">Agents download this file from the server (and verify its hash) instead of using the internet update source.</p>
                {approve && (
                  <ActionForm action={removePackageAction.bind(null, p.id)} confirm="Remove the offline package? Agents go back to the OS update source.">
                    <SubmitButton className="btn btn-sm">Remove package</SubmitButton>
                  </ActionForm>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-600">For air-gapped sites, upload the update file (.msu, .cab, .msi, .exe, .deb or .rpm). Agents then install it from this server.</p>
            )}
            {approve && (
              <form method="post" action={`/patches/${p.id}/package`} encType="multipart/form-data" className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                <input type="file" name="file" required accept=".msu,.cab,.msi,.exe,.deb,.rpm" className="block w-full text-xs" aria-label="Package file" />
                <button className="btn btn-sm">{p.package_file_id ? "Replace package" : "Upload package"}</button>
                <p className="hint">Up to 1 GB.</p>
              </form>
            )}
          </Card>
        </aside>
      </div>
    </>
  )
}
