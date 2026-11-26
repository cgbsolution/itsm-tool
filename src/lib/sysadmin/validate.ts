/**
 * Pure validators for system administration input (no I/O, unit-tested).
 * Input is the plain object from `formObject(fd)`: strings, or undefined when
 * a field was left empty. Every problem becomes a user-readable AppError.
 */
import { AppError } from "@/lib/errors"
import { isValidTimeZone } from "@/lib/itsm/clock"
import type { LdapConfig } from "@/lib/auth/ldap"

type Input = Record<string, unknown>

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/* ── primitives ────────────────────────────────────────────────────────── */

function raw(v: unknown): string {
  if (Array.isArray(v)) v = v[v.length - 1]
  return v === undefined || v === null ? "" : String(v)
}

/** Trimmed text or null; throws when required and empty, or too long. */
export function text(v: unknown, label: string, max: number, required = false): string | null {
  const s = raw(v).trim()
  if (!s) {
    if (required) throw new AppError(`${label} is required`)
    return null
  }
  if (s.length > max) throw new AppError(`${label} must be at most ${max} characters`)
  if (CONTROL_RE.test(s)) throw new AppError(`${label} contains characters that are not allowed`)
  return s
}

export function flag(v: unknown): boolean {
  const s = raw(v)
  return s === "on" || s === "true" || s === "1"
}

/** A whole number in [min, max]; `fallback` when empty (or an error when there is none). */
export function wholeNumber(v: unknown, label: string, min: number, max: number, fallback?: number | null): number | null {
  const s = raw(v).trim()
  if (!s) {
    if (fallback === undefined) throw new AppError(`${label} is required`)
    return fallback
  }
  if (!/^-?\d+$/.test(s)) throw new AppError(`${label} must be a whole number`)
  const n = Number(s)
  if (n < min || n > max) throw new AppError(`${label} must be between ${min} and ${max}`)
  return n
}

export function emailAddress(v: unknown, label: string, required = false): string | null {
  const s = text(v, label, 254, required)
  if (s === null) return null
  if (!EMAIL_RE.test(s)) throw new AppError(`${label} is not a valid email address`)
  return s.toLowerCase()
}

export function hexColor(v: unknown, label = "Brand colour"): string {
  const s = raw(v).trim()
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new AppError(`${label} must look like #2563eb`)
  return s.toLowerCase()
}

/** Host name or IP address (no scheme, no port). */
export function hostName(v: unknown, label: string, required = false): string | null {
  const s = text(v, label, 253, required)
  if (s === null) return null
  if (!/^[A-Za-z0-9.-]+$/.test(s) && !/^\[?[0-9A-Fa-f:.]+\]?$/.test(s)) throw new AppError(`${label} must be a host name or IP address`)
  return s
}

/** A new secret typed by the admin: keep the stored one, replace it, or clear it. */
export type SecretChange = { kind: "keep" } | { kind: "clear" } | { kind: "set"; value: string }

export function secretChange(newValue: unknown, clear: unknown, label = "Password"): SecretChange {
  const s = raw(newValue)
  if (s.length > 1000) throw new AppError(`${label} is too long`)
  if (s.trim()) return { kind: "set", value: s }
  return flag(clear) ? { kind: "clear" } : { kind: "keep" }
}

/** Describes a SecretChange for the audit log (never the value). */
export function secretAuditLabel(c: SecretChange): "changed" | "cleared" | "unchanged" {
  return c.kind === "set" ? "changed" : c.kind === "clear" ? "cleared" : "unchanged"
}

export function splitList(v: unknown): string[] {
  return raw(v)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

/** "corp.example.com, @example.org" → ["corp.example.com", "example.org"] */
export function emailDomains(v: unknown): string[] {
  const out: string[] = []
  for (const item of splitList(v)) {
    const d = item.replace(/^@/, "").toLowerCase()
    if (!DOMAIN_RE.test(d)) throw new AppError(`"${item}" is not a valid email domain`)
    if (!out.includes(d)) out.push(d)
  }
  if (out.length > 50) throw new AppError("List at most 50 email domains")
  return out
}

/** A role key a provider may give new accounts. Never the super admin role. */
export function assignableRole(v: unknown, allowedRoles: readonly string[], label = "Default role", fallback = "user"): string {
  const s = raw(v).trim() || fallback
  if (s === "superadmin") throw new AppError(`${label} cannot be the super administrator role`)
  if (!allowedRoles.includes(s)) throw new AppError(`${label}: "${s}" is not a role in this tenant`)
  return s
}

/* ── LDAP / Active Directory ──────────────────────────────────────────── */

/**
 * Lines "group DN = role" → [{ group_dn, role }]. A DN contains "=", so the
 * role is whatever follows the last "=".
 */
export function parseGroupRoleMap(v: unknown, allowedRoles: readonly string[]): { group_dn: string; role: string }[] {
  const out: { group_dn: string; role: string }[] = []
  const lines = raw(v).split(/\r?\n/)
  lines.forEach((line, i) => {
    const l = line.trim()
    if (!l || l.startsWith("#")) return
    const at = l.lastIndexOf("=")
    const dn = at > 0 ? l.slice(0, at).trim() : ""
    const role = at > 0 ? l.slice(at + 1).trim() : ""
    if (!dn || !role || !dn.includes("=")) throw new AppError(`Group mapping line ${i + 1}: write it as "CN=Group,OU=Groups,DC=corp,DC=local = role"`)
    if (dn.length > 1000) throw new AppError(`Group mapping line ${i + 1}: the group DN is too long`)
    out.push({ group_dn: dn, role: assignableRole(role, allowedRoles, `Group mapping line ${i + 1}`) })
  })
  if (out.length > 200) throw new AppError("Map at most 200 groups")
  return out
}

export function formatGroupRoleMap(map: { group_dn: string; role: string }[] | undefined | null): string {
  return (map ?? []).map((m) => `${m.group_dn} = ${m.role}`).join("\n")
}

function dn(v: unknown, label: string, required: boolean): string {
  const s = text(v, label, 1000, required) ?? ""
  if (s && !s.includes("=")) throw new AppError(`${label} must be a distinguished name such as DC=corp,DC=local`)
  return s
}

function attrName(v: unknown, label: string, fallback: string): string {
  const s = raw(v).trim() || fallback
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(s)) throw new AppError(`${label} must be an LDAP attribute name`)
  return s
}

/** Balanced parentheses, starts with "(", uses {{email}} or {{username}}. */
export function ldapFilter(v: unknown): string {
  const s = text(v, "User filter", 1000) ?? ""
  if (!s) return ""
  let depth = 0
  for (const c of s) {
    if (c === "(") depth++
    else if (c === ")" && --depth < 0) break
  }
  if (!s.startsWith("(") || !s.endsWith(")") || depth !== 0) throw new AppError("User filter must be a valid LDAP filter in parentheses")
  if (!s.includes("{{email}}") && !s.includes("{{username}}")) throw new AppError("User filter must contain {{email}} or {{username}}")
  return s
}

function ldapUrl(v: unknown): string {
  const s = text(v, "Server URL", 500, true)!
  if (!/^ldaps?:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?\/?$/i.test(s)) throw new AppError("Server URL must look like ldaps://dc1.corp.local:636 or ldap://dc1.corp.local:389")
  return s.replace(/\/$/, "")
}

function caFile(v: unknown): string {
  const s = text(v, "CA certificate file", 500) ?? ""
  if (!s) return ""
  if (!/^(\/|[A-Za-z]:[\\/])/.test(s)) throw new AppError("CA certificate file must be an absolute path on the server")
  if (!/\.(pem|crt|cer)$/i.test(s)) throw new AppError("CA certificate file must be a .pem, .crt or .cer file")
  return s
}

/** The stored LDAP config: exactly the keys of LdapConfig, nothing else. */
export function ldapConfigFrom(o: Input, allowedRoles: readonly string[]): Required<LdapConfig> {
  const url = ldapUrl(o.url)
  const start_tls = flag(o.start_tls)
  if (start_tls && url.toLowerCase().startsWith("ldaps://")) throw new AppError("Use either ldaps:// or StartTLS, not both")
  return {
    url,
    start_tls,
    ca_file: caFile(o.ca_file),
    bind_dn: dn(o.bind_dn, "Bind DN", true),
    base_dn: dn(o.base_dn, "Base DN", true),
    user_filter: ldapFilter(o.user_filter),
    email_attr: attrName(o.email_attr, "Email attribute", "mail"),
    name_attr: attrName(o.name_attr, "Name attribute", "displayName"),
    email_domains: emailDomains(o.email_domains),
    default_role: assignableRole(o.default_role, allowedRoles),
    group_role_map: parseGroupRoleMap(o.group_role_map, allowedRoles),
  }
}

/* ── OIDC ─────────────────────────────────────────────────────────────── */

export type OidcConfig = {
  issuer: string
  client_id: string
  scopes: string
  email_domains: string[]
  default_role: string
  allow_create: boolean
}

export const DEFAULT_OIDC_SCOPES = "openid email profile"

export function oidcIssuer(v: unknown): string {
  const s = text(v, "Issuer URL", 500, true)!
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new AppError("Issuer URL is not a valid URL")
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new AppError("Issuer URL must use https://")
  if (u.search || u.hash || u.username || u.password) throw new AppError("Issuer URL must not contain a query, fragment or credentials")
  return s
}

export function oidcScopes(v: unknown): string {
  const list = raw(v).trim() ? raw(v).trim().split(/\s+/) : DEFAULT_OIDC_SCOPES.split(" ")
  for (const s of list) if (!/^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/.test(s)) throw new AppError(`Scope "${s}" is not valid`)
  if (!list.includes("openid")) throw new AppError('Scopes must include "openid"')
  return [...new Set(list)].join(" ")
}

/** The stored OIDC config: exactly these keys. */
export function oidcConfigFrom(o: Input, allowedRoles: readonly string[]): OidcConfig {
  const clientId = text(o.client_id, "Client ID", 255, true)!
  if (/\s/.test(clientId)) throw new AppError("Client ID must not contain spaces")
  return {
    issuer: oidcIssuer(o.issuer),
    client_id: clientId,
    scopes: oidcScopes(o.scopes),
    email_domains: emailDomains(o.email_domains),
    default_role: assignableRole(o.default_role, allowedRoles),
    allow_create: flag(o.allow_create),
  }
}

/* ── tenant settings, mail, tokens, tenants, licence ──────────────────── */

export type SettingsInput = {
  brand_name: string | null
  brand_color: string
  support_email: string | null
  require_mfa: boolean
  password_min_length: number
  session_hours: number
  inbound_create_users: boolean
}

export function settingsFrom(o: Input): SettingsInput {
  return {
    brand_name: text(o.brand_name, "Brand name", 100),
    brand_color: hexColor(o.brand_color),
    support_email: emailAddress(o.support_email, "Support email"),
    require_mfa: flag(o.require_mfa),
    password_min_length: wholeNumber(o.password_min_length, "Minimum password length", 8, 128)!,
    session_hours: wholeNumber(o.session_hours, "Session length (hours)", 1, 720)!,
    inbound_create_users: flag(o.inbound_create_users),
  }
}

export type MailInput = {
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: boolean
  smtp_user: string | null
  smtp_password: SecretChange
  from_address: string | null
  imap_enabled: boolean
  imap_host: string | null
  imap_port: number
  imap_secure: boolean
  imap_user: string | null
  imap_password: SecretChange
  imap_folder: string
}

export function mailSettingsFrom(o: Input): MailInput {
  const m: MailInput = {
    smtp_host: hostName(o.smtp_host, "SMTP server"),
    smtp_port: wholeNumber(o.smtp_port, "SMTP port", 1, 65535, null),
    smtp_secure: flag(o.smtp_secure),
    smtp_user: text(o.smtp_user, "SMTP user name", 255),
    smtp_password: secretChange(o.smtp_password, o.smtp_password_clear, "SMTP password"),
    from_address: emailAddress(o.from_address, "From address"),
    imap_enabled: flag(o.imap_enabled),
    imap_host: hostName(o.imap_host, "IMAP server"),
    imap_port: wholeNumber(o.imap_port, "IMAP port", 1, 65535, 993)!,
    imap_secure: flag(o.imap_secure),
    imap_user: text(o.imap_user, "IMAP user name", 255),
    imap_password: secretChange(o.imap_password, o.imap_password_clear, "IMAP password"),
    imap_folder: text(o.imap_folder, "IMAP folder", 200) ?? "INBOX",
  }
  if (m.imap_enabled && (!m.imap_host || !m.imap_user)) throw new AppError("To turn on email-to-ticket, fill in the IMAP server and user name")
  return m
}

export type TokenInput = { name: string; userId: string; expiresDays: number | null }

export function tokenInputFrom(o: Input): TokenInput {
  const userId = raw(o.userId).trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new AppError("Choose who the token acts as")
  return {
    name: text(o.name, "Token name", 100, true)!,
    userId,
    expiresDays: wholeNumber(o.expiresDays, "Expires after (days)", 1, 3650, null),
  }
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/

export type TenantInput = { name: string; slug: string | null; timezone: string; adminEmail: string; adminName: string }

export function tenantInputFrom(o: Input): TenantInput {
  const slug = text(o.slug, "Slug", 63)?.toLowerCase() ?? null
  if (slug !== null && !SLUG_RE.test(slug)) throw new AppError("Slug must be 2–63 lowercase letters, digits or hyphens, starting with a letter or digit")
  const timezone = text(o.timezone, "Time zone", 100) ?? "UTC"
  if (!isValidTimeZone(timezone)) throw new AppError(`"${timezone}" is not a time zone (use a name such as Asia/Kolkata or Europe/London)`)
  return {
    name: text(o.name, "Tenant name", 200, true)!,
    slug,
    timezone,
    adminEmail: emailAddress(o.adminEmail, "Administrator email", true)!,
    adminName: text(o.adminName, "Administrator name", 200, true)!,
  }
}

export function licenseTextFrom(v: unknown): string {
  const s = raw(v).replace(/\s+/g, "")
  if (!s) throw new AppError("Paste the licence text")
  if (s.length > 20_000) throw new AppError("That is too long to be a licence")
  return s
}

/** Whether every permission in `want` is also in `have` (no privilege escalation). */
export function isSubset<T>(want: Iterable<T>, have: Set<T>): boolean {
  for (const p of want) if (!have.has(p)) return false
  return true
}
