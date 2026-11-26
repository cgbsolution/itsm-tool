/**
 * Password sign-in (local accounts and LDAP/AD), with per-IP and per-account
 * rate limits, account lockout, and a uniform error message.
 */
import { q, q1, exec } from "@/lib/db"
import { verifyPassword, hashPassword, needsRehash } from "@/lib/auth/password"
import { ldapAuthenticate, ldapHandlesEmail, ldapRole, type LdapConfig } from "@/lib/auth/ldap"
import { hit } from "@/lib/rate-limit"
import { auditSafe } from "@/lib/audit"
import { log } from "@/lib/log"

export const LOGIN_FAILED = "Email or password is incorrect."
const MAX_FAILURES = 5
const LOCK_MINUTES = 15

type UserRow = {
  id: string
  tenant_id: string
  email: string
  status: string
  auth_source: string
  password_hash: string | null
  failed_logins: number
  locked_until: Date | null
  mfa_enabled: boolean
  role: string
  tenant_status: string
}

export type LoginResult =
  | { ok: true; userId: string; tenantId: string; mfaEnabled: boolean }
  | { ok: false; error: string }

type ProviderRow = { id: string; tenant_id: string; config: LdapConfig; secret_enc: string | null }

let dummy: Promise<string> | null = null
function dummyHash(): Promise<string> {
  dummy ??= hashPassword("timing-equaliser-not-a-real-password")
  return dummy
}

async function ldapProviders(tenantId?: string): Promise<ProviderRow[]> {
  return q<ProviderRow>(
    `select id, tenant_id, config, secret_enc from auth_providers
      where kind = 'ldap' and enabled ${tenantId ? "and tenant_id = $1" : ""}`,
    tenantId ? [tenantId] : []
  )
}

export async function passwordLogin(emailInput: string, password: string, ip: string | null): Promise<LoginResult> {
  const email = emailInput.trim().toLowerCase()
  if (!email || !password || email.length > 320 || password.length > 200) return { ok: false, error: LOGIN_FAILED }

  const byIp = await hit(`login:ip:${ip ?? "unknown"}`, 30, 600)
  const byAccount = await hit(`login:acct:${email}`, 10, 600)
  if (!byIp.allowed || !byAccount.allowed) {
    return { ok: false, error: "Too many sign-in attempts. Wait 10 minutes and try again." }
  }

  const user = await q1<UserRow>(
    `select u.id, u.tenant_id, u.email, u.status, u.auth_source, u.password_hash, u.failed_logins, u.locked_until, u.mfa_enabled,
            u.role, t.status as tenant_status
       from users u join tenants t on t.id = u.tenant_id where lower(u.email) = $1`,
    [email]
  )

  // Unknown locally: an LDAP directory may know the person (just-in-time account)
  if (!user) {
    for (const p of await ldapProviders()) {
      if (!ldapHandlesEmail(p.config, email)) continue
      const found = await ldapAuthenticate(p.config, p.secret_enc, email, password)
      if (!found) continue
      const created = await q1<{ id: string }>(
        `insert into users (tenant_id, email, full_name, role, auth_source, external_id, status)
         values ($1, $2, $3, $4, 'ldap', $5, 'active')
         on conflict do nothing returning id`,
        [p.tenant_id, found.email, found.name, ldapRole(p.config, found.groups), found.dn]
      )
      if (!created) break
      await auditSafe({ tenantId: p.tenant_id, actor: { id: created.id, email: found.email }, action: "auth.user_provisioned", entityType: "user", entityId: created.id, summary: "Account created from LDAP sign-in", ip })
      await exec("update users set last_login_at = now() where id = $1", [created.id])
      return { ok: true, userId: created.id, tenantId: p.tenant_id, mfaEnabled: false }
    }
    // spend similar time as a real check so timing does not reveal accounts
    await verifyPassword(password, await dummyHash())
    await auditSafe({ tenantId: null, actor: null, action: "auth.login_failed", summary: "Unknown account", ip })
    return { ok: false, error: LOGIN_FAILED }
  }

  if (user.status !== "active") {
    await auditSafe({ tenantId: user.tenant_id, actor: { id: user.id }, action: "auth.login_failed", entityType: "user", entityId: user.id, summary: `Account ${user.status}`, ip })
    return { ok: false, error: LOGIN_FAILED }
  }
  if (user.tenant_status === "suspended" && user.role !== "superadmin") {
    await auditSafe({ tenantId: user.tenant_id, actor: { id: user.id }, action: "auth.login_failed", entityType: "user", entityId: user.id, summary: "Tenant suspended", ip })
    return { ok: false, error: "Your organisation's access is suspended. Contact your service provider." }
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, error: `This account is locked after too many failed attempts. Try again in ${LOCK_MINUTES} minutes or ask an administrator.` }
  }

  let ok = false
  if (user.auth_source === "ldap") {
    for (const p of await ldapProviders(user.tenant_id)) {
      const found = await ldapAuthenticate(p.config, p.secret_enc, email, password)
      if (found) {
        ok = true
        break
      }
    }
  } else {
    ok = await verifyPassword(password, user.password_hash)
    if (ok && user.password_hash && needsRehash(user.password_hash)) {
      await exec("update users set password_hash = $2 where id = $1", [user.id, await hashPassword(password)])
    }
  }

  if (!ok) {
    const failures = user.failed_logins + 1
    await exec(
      `update users set failed_logins = $2,
              locked_until = case when $2 >= $3 then now() + make_interval(mins => $4) else locked_until end
        where id = $1`,
      [user.id, failures, MAX_FAILURES, LOCK_MINUTES]
    )
    await auditSafe({ tenantId: user.tenant_id, actor: { id: user.id }, action: failures >= MAX_FAILURES ? "auth.account_locked" : "auth.login_failed", entityType: "user", entityId: user.id, ip })
    return { ok: false, error: LOGIN_FAILED }
  }

  await exec("update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1", [user.id])
  log.info("auth.login", { user_id: user.id })
  return { ok: true, userId: user.id, tenantId: user.tenant_id, mfaEnabled: user.mfa_enabled }
}
