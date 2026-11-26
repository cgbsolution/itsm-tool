/**
 * External identity providers per tenant: LDAP / Active Directory and OIDC.
 * Non-secret settings live in `config` (jsonb, exactly the documented keys);
 * the bind password / client secret is encrypted in `secret_enc` and is never
 * returned to the browser.
 */
import { q, q1, tx, exec, isUuid } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { encryptSecret } from "@/lib/crypto"
import { ldapTest, type LdapConfig } from "@/lib/auth/ldap"
import { config } from "@/lib/config"
import { AppError, notFound } from "@/lib/errors"
import { need, auditActor, requestIp, assignableRoles } from "@/lib/sysadmin/guard"
import { ldapConfigFrom, oidcConfigFrom, secretChange, secretAuditLabel, text, flag, type OidcConfig } from "@/lib/sysadmin/validate"

export type ProviderKind = "ldap" | "oidc"

export type ProviderView = {
  id: string
  kind: ProviderKind
  name: string
  enabled: boolean
  config: Record<string, unknown>
  secret_set: boolean
  created_at: Date
  updated_at: Date
}

export function isProviderKind(v: unknown): v is ProviderKind {
  return v === "ldap" || v === "oidc"
}

/** Where the IdP must send people back after sign-in (route built by the OIDC module). */
export function oidcRedirectUri(providerId: string): string {
  return `${config.appUrl()}/api/auth/oidc/${providerId}/callback`
}

const VIEW_COLUMNS = "id, kind, name, enabled, config, secret_enc is not null as secret_set, created_at, updated_at"

export async function listProviders(actor: Actor): Promise<ProviderView[]> {
  need(actor, "admin.settings")
  return q<ProviderView>(`select ${VIEW_COLUMNS} from auth_providers where tenant_id = $1 order by kind, name`, [actor.tenantId])
}

export async function getProvider(actor: Actor, id: string): Promise<ProviderView> {
  need(actor, "admin.settings")
  if (!isUuid(id)) throw notFound("Sign-in provider not found")
  const p = await q1<ProviderView>(`select ${VIEW_COLUMNS} from auth_providers where id = $1 and tenant_id = $2`, [id, actor.tenantId])
  if (!p) throw notFound("Sign-in provider not found")
  return p
}

async function parseConfig(actor: Actor, kind: ProviderKind, input: Record<string, unknown>): Promise<LdapConfig | OidcConfig> {
  const roles = (await assignableRoles(actor.tenantId)).map((r) => r.key)
  return kind === "ldap" ? ldapConfigFrom(input, roles) : oidcConfigFrom(input, roles)
}

/** Creates (id null) or updates a provider. Returns its id. */
export async function saveProvider(actor: Actor, id: string | null, kind: ProviderKind, input: Record<string, unknown>): Promise<string> {
  need(actor, "admin.settings")
  if (!isProviderKind(kind)) throw new AppError("Unknown provider type")
  const name = text(input.name, "Name", 100, true)!
  const enabled = flag(input.enabled)
  const cfg = await parseConfig(actor, kind, input)
  const secret = secretChange(input.secret, input.secret_clear, kind === "ldap" ? "Bind password" : "Client secret")
  const ip = await requestIp()
  return tx(async (db) => {
    let providerId: string
    if (id) {
      if (!isUuid(id)) throw notFound("Sign-in provider not found")
      const cur = await q1<{ id: string; kind: string; secret_enc: string | null }>(
        "select id, kind, secret_enc from auth_providers where id = $1 and tenant_id = $2 for update",
        [id, actor.tenantId],
        db
      )
      if (!cur) throw notFound("Sign-in provider not found")
      if (cur.kind !== kind) throw new AppError("The provider type cannot be changed")
      const secretEnc = secret.kind === "set" ? encryptSecret(secret.value) : secret.kind === "clear" ? null : cur.secret_enc
      if (kind === "oidc" && enabled && !secretEnc) throw new AppError("Set the client secret before turning this provider on")
      await exec(
        "update auth_providers set name = $3, enabled = $4, config = $5, secret_enc = $6, updated_at = now() where id = $1 and tenant_id = $2",
        [id, actor.tenantId, name, enabled, JSON.stringify(cfg), secretEnc],
        db
      )
      providerId = id
    } else {
      const secretEnc = secret.kind === "set" ? encryptSecret(secret.value) : null
      if (kind === "oidc" && enabled && !secretEnc) throw new AppError("Set the client secret before turning this provider on")
      const row = await q1<{ id: string }>(
        "insert into auth_providers (tenant_id, kind, name, enabled, config, secret_enc) values ($1, $2, $3, $4, $5, $6) returning id",
        [actor.tenantId, kind, name, enabled, JSON.stringify(cfg), secretEnc],
        db
      )
      providerId = row!.id
    }
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: id ? "admin.auth_provider_updated" : "admin.auth_provider_created",
        entityType: "auth_provider",
        entityId: providerId,
        summary: `${id ? "Updated" : "Added"} ${kind.toUpperCase()} sign-in provider "${name}"${enabled ? "" : " (off)"}`,
        data: { kind, name, enabled, config: cfg, secret: secretAuditLabel(secret) },
        ip,
      },
      db
    )
    return providerId
  })
}

export async function deleteProvider(actor: Actor, id: string): Promise<void> {
  need(actor, "admin.settings")
  if (!isUuid(id)) throw notFound("Sign-in provider not found")
  const ip = await requestIp()
  await tx(async (db) => {
    const row = await q1<{ kind: string; name: string }>("delete from auth_providers where id = $1 and tenant_id = $2 returning kind, name", [id, actor.tenantId], db)
    if (!row) throw notFound("Sign-in provider not found")
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.auth_provider_deleted",
        entityType: "auth_provider",
        entityId: id,
        summary: `Removed ${row.kind.toUpperCase()} sign-in provider "${row.name}"`,
        ip,
      },
      db
    )
  })
}

/** Binds with the saved service account and reads the base DN. */
export async function testLdapProvider(actor: Actor, id: string): Promise<string> {
  need(actor, "admin.settings")
  if (!isUuid(id)) throw notFound("Sign-in provider not found")
  const p = await q1<{ kind: string; config: LdapConfig; secret_enc: string | null }>(
    "select kind, config, secret_enc from auth_providers where id = $1 and tenant_id = $2",
    [id, actor.tenantId]
  )
  if (!p) throw notFound("Sign-in provider not found")
  if (p.kind !== "ldap") throw new AppError("Only LDAP providers can be tested here")
  try {
    return await ldapTest(p.config, p.secret_enc)
  } catch (err) {
    const msg = ((err as Error)?.message ?? "unknown error").replace(/\s+/g, " ").slice(0, 300)
    throw new AppError(`Connection failed: ${msg}`)
  }
}
