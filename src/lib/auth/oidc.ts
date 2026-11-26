/**
 * OpenID Connect sign-in (Entra ID, Keycloak, Google Workspace, ADFS …).
 * Authorization code flow with PKCE, state and nonce. Provider config is in
 * auth_providers (kind 'oidc'): { issuer, client_id, scopes, email_domains, default_role, allow_create }.
 */
import * as oidc from "openid-client"
import { q1 } from "@/lib/db"
import { maybeDecrypt } from "@/lib/crypto"
import { AppError } from "@/lib/errors"

export type OidcConfig = {
  issuer: string
  client_id: string
  scopes?: string
  email_domains?: string[]
  default_role?: string
  allow_create?: boolean
}

export type OidcProvider = { id: string; tenant_id: string; name: string; config: OidcConfig; secret_enc: string | null; updated_at: Date }

const cache = new Map<string, { at: number; key: string; conf: oidc.Configuration }>()

export async function loadProvider(id: string): Promise<OidcProvider> {
  const p = await q1<OidcProvider>(
    "select id, tenant_id, name, config, secret_enc, updated_at from auth_providers where id = $1 and kind = 'oidc' and enabled",
    [id]
  )
  if (!p || !p.config?.issuer || !p.config?.client_id) throw new AppError("This sign-in option is not available", 404)
  return p
}

export async function discover(p: OidcProvider): Promise<oidc.Configuration> {
  const key = `${p.id}:${new Date(p.updated_at).getTime()}`
  const hit = cache.get(p.id)
  if (hit && hit.key === key && Date.now() - hit.at < 3600_000) return hit.conf
  const issuer = new URL(p.config.issuer)
  const conf = await oidc.discovery(
    issuer,
    p.config.client_id,
    maybeDecrypt(p.secret_enc),
    undefined,
    issuer.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined
  )
  cache.set(p.id, { at: Date.now(), key, conf })
  return conf
}

export function emailAllowed(cfg: OidcConfig, email: string): boolean {
  if (!cfg.email_domains?.length) return true
  const domain = email.split("@")[1]?.toLowerCase()
  return !!domain && cfg.email_domains.map((d) => d.toLowerCase().replace(/^@/, "")).includes(domain)
}

export { oidc }
