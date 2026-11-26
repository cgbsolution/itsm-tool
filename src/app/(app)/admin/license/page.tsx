import { requirePermission } from "@/lib/auth/session"
import { getLicenseView } from "@/lib/sysadmin/license"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, KeyValues, PageHeader, type Tone } from "@/components/ui"
import { formatDate, formatDateTime } from "@/lib/format"
import { installLicenseAction, removeLicenseAction } from "./actions"

export const metadata = { title: "Licence" }

const MODE: Record<string, { label: string; tone: Tone }> = {
  licensed: { label: "Licensed", tone: "green" },
  evaluation: { label: "Evaluation", tone: "amber" },
  expired: { label: "Expired", tone: "red" },
  invalid: { label: "Invalid", tone: "red" },
}

const KEY_SOURCE: Record<string, string> = {
  env: "Configured (LICENSE_PUBLIC_KEY)",
  file: "Configured (LICENSE_PUBLIC_KEY_FILE)",
  missing_file: "LICENSE_PUBLIC_KEY_FILE is set, but the file does not exist",
  none: "Not configured",
}

export default async function LicensePage() {
  const actor = await requirePermission("admin.license")
  const v = await getLicenseView(actor)
  const tz = actor.tenant.timezone
  const p = v.status.payload
  const mode = MODE[v.status.mode] ?? { label: v.status.mode, tone: "gray" as Tone }
  const over = v.status.maxDevices > 0 && v.devicesUsed > v.status.maxDevices
  return (
    <>
      <PageHeader title="Licence" subtitle="The licence covers this whole installation (all tenants)" back={{ href: "/admin", label: "Administration" }} />
      {v.status.banner && (
        <div className={`mb-4 rounded-md px-4 py-2 text-sm ring-1 ${v.status.level === "error" ? "bg-red-50 text-red-800 ring-red-200" : "bg-amber-50 text-amber-900 ring-amber-200"}`}>{v.status.banner}</div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Status">
          <KeyValues
            items={[
              ["Mode", <Badge key="m" tone={mode.tone}>{mode.label}</Badge>],
              ["Licensee", p?.licensee ?? "—"],
              ["Licence ID", p?.license_id ? <code key="id" className="text-xs">{p.license_id}</code> : "—"],
              ["Issued", p?.issued_at ? formatDate(p.issued_at, tz) : "—"],
              ["Expires", p ? (p.expires_at ? formatDate(p.expires_at, tz) : "Never") : "—"],
              ["Modules", p?.modules?.length ? p.modules.join(", ") : "—"],
              [
                "Managed devices",
                <span key="d" className={over ? "font-medium text-red-700" : undefined}>
                  {v.devicesUsed} of {v.status.maxDevices === 0 ? "0 (no new enrolments)" : v.status.maxDevices}
                </span>,
              ],
              ["Installed", v.installedAt ? `${formatDateTime(v.installedAt, tz)}${v.installedBy ? ` by ${v.installedBy}` : ""}` : "Not installed"],
              ["Public key", KEY_SOURCE[v.publicKey]],
            ]}
          />
          {v.installedAt && (
            <ActionForm action={removeLicenseAction} confirm="Remove the licence? The installation falls back to evaluation limits." className="mt-4">
              <SubmitButton className="btn btn-danger btn-sm">Remove licence</SubmitButton>
            </ActionForm>
          )}
        </Card>

        <Card title="Install a licence">
          <ActionForm action={installLicenseAction} className="space-y-3" resetOnSuccess>
            <textarea name="license" required rows={6} maxLength={20_000} className="input font-mono text-xs" placeholder="ITSM-LICENSE-V1.…" spellCheck={false} />
            <p className="hint">Paste the whole licence text from the vendor. It is checked on this server; nothing is sent anywhere.</p>
            <SubmitButton pendingText="Checking…">Install licence</SubmitButton>
          </ActionForm>
        </Card>

        <Card title="How licensing works" className="lg:col-span-2">
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              A licence is a text block signed by the vendor with an Ed25519 private key. This server verifies it offline with the vendor&apos;s public key,
              so it works without internet access. Without a valid licence the installation runs in evaluation mode with a device limit; an expired licence
              never locks anyone out of the service desk, it only stops new device enrolments.
            </p>
            <p>
              <strong>Public key:</strong> put the vendor&apos;s public key (PEM) in a file on the server and set <code>LICENSE_PUBLIC_KEY_FILE</code> to its path
              (or put the PEM itself in <code>LICENSE_PUBLIC_KEY</code>), then restart the application.
            </p>
            <p>
              <strong>Issuing (vendor only):</strong> the vendor creates a key pair once with <code>npm run license:keygen</code> and issues licences with{" "}
              <code>npm run license:issue</code>, keeping the private key off customer servers.
            </p>
          </div>
        </Card>
      </div>
    </>
  )
}
