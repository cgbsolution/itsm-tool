/** Tenant settings: branding, sign-in policy, email-to-ticket account creation. */
import { q1, tx } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { need, auditActor, requestIp } from "@/lib/sysadmin/guard"
import { settingsFrom, type SettingsInput } from "@/lib/sysadmin/validate"

export type GeneralSettings = SettingsInput & { updated_at: Date | null }

const DEFAULTS: GeneralSettings = {
  brand_name: null,
  brand_color: "#2563eb",
  support_email: null,
  require_mfa: false,
  password_min_length: 10,
  session_hours: 12,
  inbound_create_users: false,
  updated_at: null,
}

const COLUMNS = "brand_name, brand_color, support_email, require_mfa, password_min_length, session_hours, inbound_create_users, updated_at"

export async function getGeneralSettings(actor: Actor): Promise<GeneralSettings> {
  need(actor, "admin.settings")
  const row = await q1<GeneralSettings>(`select ${COLUMNS} from tenant_settings where tenant_id = $1`, [actor.tenantId])
  return row ?? DEFAULTS
}

export async function updateGeneralSettings(actor: Actor, input: Record<string, unknown>): Promise<void> {
  need(actor, "admin.settings")
  const s = settingsFrom(input)
  const ip = await requestIp()
  await tx(async (db) => {
    const before = await q1<GeneralSettings>(`select ${COLUMNS} from tenant_settings where tenant_id = $1 for update`, [actor.tenantId], db)
    await q1(
      `insert into tenant_settings (tenant_id, brand_name, brand_color, support_email, require_mfa, password_min_length, session_hours, inbound_create_users, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (tenant_id) do update set
         brand_name = excluded.brand_name, brand_color = excluded.brand_color, support_email = excluded.support_email,
         require_mfa = excluded.require_mfa, password_min_length = excluded.password_min_length,
         session_hours = excluded.session_hours, inbound_create_users = excluded.inbound_create_users, updated_at = now()`,
      [actor.tenantId, s.brand_name, s.brand_color, s.support_email, s.require_mfa, s.password_min_length, s.session_hours, s.inbound_create_users],
      db
    )
    const old = before ?? DEFAULTS
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const k of Object.keys(s) as (keyof SettingsInput)[]) if (old[k] !== s[k]) changes[k] = { from: old[k], to: s[k] }
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.settings_updated",
        entityType: "tenant",
        entityId: actor.tenantId,
        summary: Object.keys(changes).length ? `Changed ${Object.keys(changes).join(", ")}` : "Saved settings (no changes)",
        data: { changes },
        ip,
      },
      db
    )
  })
}
