/** Licence administration: status, install (verified offline), remove. */
import fs from "node:fs"
import { q1, tx, exec } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { licenseStatus, verifyLicenseText, clearLicenseCache, type LicenseStatus } from "@/lib/license"
import { config } from "@/lib/config"
import { AppError } from "@/lib/errors"
import { need, auditActor, requestIp } from "@/lib/sysadmin/guard"
import { licenseTextFrom } from "@/lib/sysadmin/validate"

export type LicenseView = {
  status: LicenseStatus
  /** Active managed devices on this installation (the licence covers all tenants) */
  devicesUsed: number
  installedAt: Date | null
  installedBy: string | null
  publicKey: "env" | "file" | "missing_file" | "none"
}

function publicKeySource(): LicenseView["publicKey"] {
  if (config.licensePublicKeyPem()) return "env"
  const file = config.licensePublicKeyFile()
  if (!file) return "none"
  return fs.existsSync(file) ? "file" : "missing_file"
}

export async function getLicenseView(actor: Actor): Promise<LicenseView> {
  need(actor, "admin.license")
  const [status, devices, row] = await Promise.all([
    licenseStatus(true),
    q1<{ n: number }>("select count(*) as n from devices where status = 'active'"),
    q1<{ installed_at: Date; installed_by: string | null }>(
      "select l.installed_at, coalesce(nullif(u.full_name, ''), u.email) as installed_by from license l left join users u on u.id = l.installed_by where l.id = 1"
    ),
  ])
  return {
    status,
    devicesUsed: devices?.n ?? 0,
    installedAt: row?.installed_at ?? null,
    installedBy: row?.installed_by ?? null,
    publicKey: publicKeySource(),
  }
}

export async function installLicense(actor: Actor, rawText: unknown): Promise<string> {
  need(actor, "admin.license")
  const text = licenseTextFrom(rawText)
  const v = verifyLicenseText(text)
  if (!v.ok) throw new AppError(v.error)
  const p = v.payload
  const ip = await requestIp()
  await tx(async (db) => {
    await exec(
      `insert into license (id, license_text, installed_at, installed_by) values (1, $1, now(), $2)
       on conflict (id) do update set license_text = excluded.license_text, installed_at = now(), installed_by = excluded.installed_by`,
      [text, actor.id],
      db
    )
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.license_installed",
        entityType: "license",
        entityId: p.license_id ?? "1",
        summary: `Licence installed for ${p.licensee} (${p.max_devices} devices${p.expires_at ? `, until ${p.expires_at.slice(0, 10)}` : ""})`,
        data: { licensee: p.licensee, license_id: p.license_id, issued_at: p.issued_at, expires_at: p.expires_at, max_devices: p.max_devices, modules: p.modules },
        ip,
      },
      db
    )
  })
  clearLicenseCache()
  return p.licensee
}

export async function removeLicense(actor: Actor): Promise<void> {
  need(actor, "admin.license")
  const ip = await requestIp()
  await tx(async (db) => {
    const n = await exec("delete from license where id = 1", [], db)
    if (!n) throw new AppError("No licence is installed", 409)
    await audit(
      { tenantId: actor.tenantId, actor: auditActor(actor), action: "admin.license_removed", entityType: "license", entityId: "1", summary: "Licence removed; evaluation limits apply", ip },
      db
    )
  })
  clearLicenseCache()
}
