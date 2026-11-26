import fs from "node:fs"
import path from "node:path"
import { requirePermission } from "@/lib/auth/session"
import { config } from "@/lib/config"
import { licenseStatus } from "@/lib/license"
import { q1 } from "@/lib/db"
import { listDeviceGroups, listEnrollmentTokens } from "@/lib/endpoints/queries"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, PageHeader, When } from "@/components/ui"
import { formatDateTime } from "@/lib/format"
import { installCommands } from "@/lib/endpoints/vocab"
import { CommandLine, TokenCreateForm } from "../client"
import { createTokenAction, revokeTokenAction } from "../actions"

export const metadata = { title: "Enrol devices" }

const TOKEN_TONE = { active: "green", revoked: "red", expired: "gray", used_up: "gray" } as const
const TOKEN_LABEL = { active: "Active", revoked: "Revoked", expired: "Expired", used_up: "Used up" } as const

export default async function EnrolPage() {
  const actor = await requirePermission("endpoint.manage")
  const tz = actor.tenant.timezone
  const [tokens, groups, license, count] = await Promise.all([
    listEnrollmentTokens(actor.tenantId),
    listDeviceGroups(actor.tenantId),
    licenseStatus(),
    q1<{ n: number }>("select count(*) as n from devices where tenant_id = $1 and status = 'active'", [actor.tenantId]),
  ])
  const server = config.appUrl()
  const placeholder = installCommands(server, "<token>")
  const hasAgent = {
    windows: fs.existsSync(path.join(process.cwd(), "agent", "windows", "itsm-agent.ps1")),
    linux: fs.existsSync(path.join(process.cwd(), "agent", "linux", "itsm-agent.py")),
  }
  const used = count?.n ?? 0

  return (
    <>
      <PageHeader
        back={{ href: "/endpoints", label: "Devices" }}
        title="Enrol devices"
        subtitle={`${used} of ${license.maxDevices} licensed devices in use${license.mode !== "licensed" ? ` (${license.mode})` : ""}`}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Create an enrolment token">
          <TokenCreateForm action={createTokenAction} serverUrl={server}>
            <div>
              <label className="label" htmlFor="tname">Name</label>
              <input id="tname" name="name" required minLength={2} maxLength={100} className="input" placeholder="e.g. Head office laptops, November rollout" />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="tgroup">Device group</label>
                <select id="tgroup" name="groupId" className="input" defaultValue={groups.find((g) => g.name === "Production")?.id ?? ""}>
                  <option value="">— No group —</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} (ring {g.ring})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="texp">Expires</label>
                <input id="texp" name="expiresAt" type="datetime-local" className="input" />
              </div>
              <div>
                <label className="label" htmlFor="tmax">Max uses</label>
                <input id="tmax" name="maxUses" type="number" min={1} max={1000000} className="input" placeholder="Unlimited" />
              </div>
            </div>
            <p className="hint">New devices join the chosen group. Times are in {tz}. Give each rollout its own token and revoke it when done.</p>
            <SubmitButton>Create token</SubmitButton>
          </TokenCreateForm>
        </Card>

        <Card title="2. Install the agent">
          <div className="space-y-4 text-sm">
            <div>
              <h3 className="mb-1 font-medium">Windows</h3>
              <p className="mb-2 text-slate-600">
                {hasAgent.windows ? <a href="/api/agent/download/windows">Download itsm-agent.ps1</a> : <span className="text-slate-400">itsm-agent.ps1 (not in this build yet)</span>}{" "}
                while signed in here, copy it to the device, then run in an <strong>administrator</strong> PowerShell in that folder:
              </p>
              <CommandLine command={placeholder.windows} />
            </div>
            <div>
              <h3 className="mb-1 font-medium">Linux</h3>
              <p className="mb-2 text-slate-600">
                {hasAgent.linux ? <a href="/api/agent/download/linux">Download itsm-agent.py</a> : <span className="text-slate-400">itsm-agent.py (not in this build yet)</span>}{" "}
                (needs Python 3), copy it to the device, then run in that folder:
              </p>
              <CommandLine command={placeholder.linux} />
            </div>
            <p className="hint">
              The agent only makes outbound connections to {server}; nothing needs to reach the device. It enrols, sends an inventory and a patch scan,
              then checks in every minute. Replace &lt;token&gt; with a token from step 1; the commands are filled in for you when you create one.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Enrolment tokens" className="mt-4" bodyClassName="p-0">
        {tokens.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No tokens yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Token</th>
                  <th>Group</th>
                  <th>Uses</th>
                  <th>Expires</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td className="font-medium">{t.name}</td>
                    <td className="font-mono text-xs text-slate-500">{t.prefix}…</td>
                    <td className="text-slate-600">{t.group_name ?? "—"}</td>
                    <td className="text-slate-600">
                      {t.uses}
                      {t.max_uses !== null ? ` / ${t.max_uses}` : ""}
                    </td>
                    <td className="text-xs whitespace-nowrap text-slate-500">{t.expires_at ? formatDateTime(t.expires_at, tz) : "Never"}</td>
                    <td className="text-xs whitespace-nowrap text-slate-500">
                      <When value={t.created_at} timeZone={tz} />
                      {t.created_by_name ? ` by ${t.created_by_name}` : ""}
                    </td>
                    <td><Badge tone={TOKEN_TONE[t.state]}>{TOKEN_LABEL[t.state]}</Badge></td>
                    <td className="text-right">
                      {!t.revoked_at && (
                        <ActionForm action={revokeTokenAction.bind(null, t.id)} confirm={`Revoke "${t.name}"? Devices already enrolled keep working.`}>
                          <SubmitButton className="btn btn-sm">Revoke</SubmitButton>
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
