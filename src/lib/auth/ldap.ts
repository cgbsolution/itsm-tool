/**
 * LDAP / Active Directory sign-in: bind with a service account, find the user,
 * then bind as the user to check the password. Group membership maps to roles.
 */
import { Client } from "ldapts"
import fs from "node:fs"
import { maybeDecrypt } from "@/lib/crypto"
import { log } from "@/lib/log"

export type LdapConfig = {
  url: string                    // ldaps://dc1.corp.local:636 or ldap://…:389
  start_tls?: boolean
  ca_file?: string               // PEM file on the server for a private CA
  bind_dn: string                // service account
  base_dn: string
  /** {{email}} and {{username}} are replaced (escaped). */
  user_filter?: string
  email_attr?: string
  name_attr?: string
  email_domains?: string[]       // which sign-in emails go to this directory
  default_role?: string
  group_role_map?: { group_dn: string; role: string }[]
}

export type LdapUser = { dn: string; email: string; name: string; groups: string[] }

const DEFAULT_FILTER = "(&(objectClass=person)(|(mail={{email}})(userPrincipalName={{email}})(sAMAccountName={{username}})))"

/** RFC 4515 escaping for filter values. */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"))
}

function client(cfg: LdapConfig) {
  const tlsOptions = cfg.ca_file ? { ca: [fs.readFileSync(cfg.ca_file)] } : undefined
  return new Client({ url: cfg.url, timeout: 8000, connectTimeout: 8000, tlsOptions })
}

export function ldapHandlesEmail(cfg: LdapConfig, email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase()
  if (!cfg.email_domains || cfg.email_domains.length === 0) return true
  return !!domain && cfg.email_domains.map((d) => d.toLowerCase()).includes(domain)
}

export async function ldapAuthenticate(cfg: LdapConfig, secretEnc: string | null, email: string, password: string): Promise<LdapUser | null> {
  if (!password) return null // an empty password would be an anonymous bind
  const svc = client(cfg)
  try {
    if (cfg.start_tls) await svc.startTLS(cfg.ca_file ? { ca: [fs.readFileSync(cfg.ca_file)] } : {})
    await svc.bind(cfg.bind_dn, maybeDecrypt(secretEnc) ?? "")
    const filter = (cfg.user_filter || DEFAULT_FILTER)
      .replaceAll("{{email}}", escapeFilter(email))
      .replaceAll("{{username}}", escapeFilter(email.split("@")[0]))
    const emailAttr = cfg.email_attr || "mail"
    const nameAttr = cfg.name_attr || "displayName"
    const { searchEntries } = await svc.search(cfg.base_dn, {
      scope: "sub",
      filter,
      attributes: ["dn", emailAttr, nameAttr, "memberOf"],
      sizeLimit: 2,
    })
    if (searchEntries.length !== 1) return null
    const entry = searchEntries[0]
    const userClient = client(cfg)
    try {
      if (cfg.start_tls) await userClient.startTLS(cfg.ca_file ? { ca: [fs.readFileSync(cfg.ca_file)] } : {})
      await userClient.bind(entry.dn, password)
    } catch {
      return null
    } finally {
      await userClient.unbind().catch(() => {})
    }
    const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : v ? String(v) : "")
    const groups = Array.isArray(entry.memberOf) ? entry.memberOf.map(String) : entry.memberOf ? [String(entry.memberOf)] : []
    return {
      dn: entry.dn,
      email: (first(entry[emailAttr]) || email).toLowerCase(),
      name: first(entry[nameAttr]) || email,
      groups,
    }
  } catch (err) {
    log.warn("auth.ldap_error", { url: cfg.url, err })
    return null
  } finally {
    await svc.unbind().catch(() => {})
  }
}

/** Role from group membership (first match), else the provider default. */
export function ldapRole(cfg: LdapConfig, groups: string[]): string {
  const lower = groups.map((g) => g.toLowerCase())
  for (const m of cfg.group_role_map ?? []) {
    if (lower.includes(m.group_dn.toLowerCase()) && m.role !== "superadmin") return m.role
  }
  return cfg.default_role && cfg.default_role !== "superadmin" ? cfg.default_role : "user"
}

/** Connection test for the admin screen. */
export async function ldapTest(cfg: LdapConfig, secretEnc: string | null): Promise<string> {
  const svc = client(cfg)
  try {
    if (cfg.start_tls) await svc.startTLS(cfg.ca_file ? { ca: [fs.readFileSync(cfg.ca_file)] } : {})
    await svc.bind(cfg.bind_dn, maybeDecrypt(secretEnc) ?? "")
    const { searchEntries } = await svc.search(cfg.base_dn, { scope: "base", filter: "(objectClass=*)", sizeLimit: 1 })
    return searchEntries.length ? "Connected and bound successfully." : "Bound, but the base DN was not found."
  } finally {
    await svc.unbind().catch(() => {})
  }
}
