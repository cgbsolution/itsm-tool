import { describe, expect, it } from "vitest"
import {
  assignableRole,
  emailDomains,
  formatGroupRoleMap,
  hexColor,
  isSubset,
  ldapConfigFrom,
  ldapFilter,
  licenseTextFrom,
  mailSettingsFrom,
  oidcConfigFrom,
  oidcIssuer,
  oidcScopes,
  parseGroupRoleMap,
  secretAuditLabel,
  secretChange,
  settingsFrom,
  tenantInputFrom,
  tokenInputFrom,
  wholeNumber,
} from "@/lib/sysadmin/validate"
import { permissionsFor } from "@/lib/auth/permissions"

const ROLES = ["user", "engineer", "admin", "cab_member"]

describe("tenant settings", () => {
  const valid = { brand_color: "#1D4ED8", password_min_length: "12", session_hours: "8" }
  it("accepts valid input and normalises it", () => {
    const s = settingsFrom({ ...valid, brand_name: "  Acme IT ", support_email: "Help@Acme.COM", require_mfa: "on" })
    expect(s).toEqual({
      brand_name: "Acme IT",
      brand_color: "#1d4ed8",
      support_email: "help@acme.com",
      require_mfa: true,
      password_min_length: 12,
      session_hours: 8,
      inbound_create_users: false,
    })
  })
  it("enforces the documented limits", () => {
    expect(() => settingsFrom({ ...valid, password_min_length: "7" })).toThrow(/between 8 and 128/)
    expect(() => settingsFrom({ ...valid, password_min_length: "129" })).toThrow(/between 8 and 128/)
    expect(() => settingsFrom({ ...valid, session_hours: "0" })).toThrow(/between 1 and 720/)
    expect(() => settingsFrom({ ...valid, session_hours: "721" })).toThrow(/between 1 and 720/)
    expect(() => settingsFrom({ ...valid, session_hours: "1.5" })).toThrow(/whole number/)
    expect(() => settingsFrom({ ...valid, brand_color: "blue" })).toThrow(/#2563eb/)
    expect(() => settingsFrom({ ...valid, support_email: "not-an-email" })).toThrow(/valid email/)
    expect(() => settingsFrom({ ...valid, brand_name: "x".repeat(101) })).toThrow(/at most 100/)
  })
  it("parses colours and numbers strictly", () => {
    expect(hexColor("#ABCDEF")).toBe("#abcdef")
    expect(() => hexColor("#abc")).toThrow()
    expect(wholeNumber("", "Port", 1, 10, null)).toBeNull()
    expect(() => wholeNumber("", "Port", 1, 10)).toThrow(/required/)
  })
})

describe("secrets", () => {
  it("keeps, sets or clears a stored secret", () => {
    expect(secretChange(undefined, undefined)).toEqual({ kind: "keep" })
    expect(secretChange("   ", undefined)).toEqual({ kind: "keep" })
    expect(secretChange(undefined, "on")).toEqual({ kind: "clear" })
    expect(secretChange("s3cret ", "on")).toEqual({ kind: "set", value: "s3cret " })
  })
  it("never puts the value in the audit label", () => {
    expect(secretAuditLabel({ kind: "set", value: "hunter2" })).toBe("changed")
    expect(secretAuditLabel({ kind: "clear" })).toBe("cleared")
    expect(secretAuditLabel({ kind: "keep" })).toBe("unchanged")
  })
})

describe("mail settings", () => {
  it("accepts SMTP only and defaults IMAP", () => {
    const m = mailSettingsFrom({ smtp_host: "smtp.example.com", smtp_port: "587", smtp_user: "desk", smtp_password: "pw", from_address: "desk@example.com" })
    expect(m.smtp_port).toBe(587)
    expect(m.smtp_password).toEqual({ kind: "set", value: "pw" })
    expect(m.imap_port).toBe(993)
    expect(m.imap_folder).toBe("INBOX")
    expect(m.imap_password).toEqual({ kind: "keep" })
  })
  it("requires the IMAP server and user when email-to-ticket is on", () => {
    expect(() => mailSettingsFrom({ imap_enabled: "on", imap_host: "imap.example.com" })).toThrow(/IMAP server and user/)
    expect(() => mailSettingsFrom({ smtp_port: "70000" })).toThrow(/between 1 and 65535/)
    expect(() => mailSettingsFrom({ smtp_host: "smtp://x" })).toThrow(/host name/)
    expect(() => mailSettingsFrom({ from_address: "Desk <desk@example.com>" })).toThrow(/valid email/)
  })
})

describe("LDAP configuration", () => {
  const base = { url: "ldaps://dc1.corp.local:636", bind_dn: "CN=svc,OU=Svc,DC=corp,DC=local", base_dn: "DC=corp,DC=local" }
  it("stores exactly the documented keys with defaults", () => {
    const c = ldapConfigFrom(base, ROLES)
    expect(Object.keys(c).sort()).toEqual(
      ["url", "start_tls", "ca_file", "bind_dn", "base_dn", "user_filter", "email_attr", "name_attr", "email_domains", "default_role", "group_role_map"].sort()
    )
    expect(c).toMatchObject({ start_tls: false, email_attr: "mail", name_attr: "displayName", default_role: "user", email_domains: [], group_role_map: [] })
  })
  it("ignores unknown keys", () => {
    const c = ldapConfigFrom({ ...base, evil: "x", secret: "pw" }, ROLES) as Record<string, unknown>
    expect(c.evil).toBeUndefined()
    expect(c.secret).toBeUndefined()
  })
  it("validates the server, DNs, TLS and filter", () => {
    expect(() => ldapConfigFrom({ ...base, url: "http://dc1" }, ROLES)).toThrow(/ldaps:\/\//)
    expect(() => ldapConfigFrom({ ...base, start_tls: "on" }, ROLES)).toThrow(/not both/)
    expect(ldapConfigFrom({ ...base, url: "ldap://dc1:389", start_tls: "on" }, ROLES).start_tls).toBe(true)
    expect(() => ldapConfigFrom({ ...base, bind_dn: "svc-account" }, ROLES)).toThrow(/distinguished name/)
    expect(() => ldapConfigFrom({ ...base, ca_file: "relative/ca.pem" }, ROLES)).toThrow(/absolute/)
    expect(() => ldapConfigFrom({ ...base, ca_file: "/etc/passwd" }, ROLES)).toThrow(/\.pem/)
    expect(ldapConfigFrom({ ...base, ca_file: "C:\\certs\\ca.pem" }, ROLES).ca_file).toBe("C:\\certs\\ca.pem")
    expect(ldapFilter("(&(objectClass=person)(mail={{email}}))")).toContain("{{email}}")
    expect(() => ldapFilter("(mail={{email}}")).toThrow(/valid LDAP filter/)
    expect(() => ldapFilter("(objectClass=person)")).toThrow(/\{\{email\}\}/)
  })
  it("parses the group → role lines on the last =", () => {
    const map = parseGroupRoleMap("CN=IT Admins,OU=Groups,DC=corp,DC=local = admin\n\n# comment\nCN=Desk,DC=corp=engineer", ROLES)
    expect(map).toEqual([
      { group_dn: "CN=IT Admins,OU=Groups,DC=corp,DC=local", role: "admin" },
      { group_dn: "CN=Desk,DC=corp", role: "engineer" },
    ])
    expect(formatGroupRoleMap(map)).toBe("CN=IT Admins,OU=Groups,DC=corp,DC=local = admin\nCN=Desk,DC=corp = engineer")
    expect(parseGroupRoleMap(formatGroupRoleMap(map), ROLES)).toEqual(map)
    expect(() => parseGroupRoleMap("just text", ROLES)).toThrow(/line 1/)
    expect(() => parseGroupRoleMap("CN=X,DC=y = wizard", ROLES)).toThrow(/not a role/)
  })
  it("never maps to the super administrator role", () => {
    expect(() => parseGroupRoleMap("CN=Root,DC=corp = superadmin", [...ROLES, "superadmin"])).toThrow(/super administrator/)
    expect(() => ldapConfigFrom({ ...base, default_role: "superadmin" }, [...ROLES, "superadmin"])).toThrow(/super administrator/)
    expect(() => assignableRole("superadmin", ["superadmin"])).toThrow(/super administrator/)
    expect(assignableRole(undefined, ROLES)).toBe("user")
  })
  it("normalises email domains", () => {
    expect(emailDomains("Corp.Example.com, @example.org example.org")).toEqual(["corp.example.com", "example.org"])
    expect(() => emailDomains("not a domain!")).toThrow(/not a valid email domain/)
  })
})

describe("OIDC configuration", () => {
  const base = { issuer: "https://login.example.com/realms/corp", client_id: "itsm" }
  it("stores exactly the documented keys with defaults", () => {
    const c = oidcConfigFrom(base, ROLES)
    expect(c).toEqual({ issuer: base.issuer, client_id: "itsm", scopes: "openid email profile", email_domains: [], default_role: "user", allow_create: false })
  })
  it("validates the issuer and scopes", () => {
    expect(() => oidcIssuer("http://idp.example.com")).toThrow(/https/)
    expect(oidcIssuer("http://localhost:8080/realms/dev")).toBe("http://localhost:8080/realms/dev")
    expect(() => oidcIssuer("https://idp.example.com/?x=1")).toThrow(/query/)
    expect(() => oidcIssuer("not a url")).toThrow(/valid URL/)
    expect(oidcScopes("openid  email openid groups")).toBe("openid email groups")
    expect(() => oidcScopes("email profile")).toThrow(/openid/)
    expect(() => oidcConfigFrom({ ...base, client_id: "a b" }, ROLES)).toThrow(/spaces/)
    expect(() => oidcConfigFrom({ ...base, default_role: "superadmin" }, [...ROLES, "superadmin"])).toThrow(/super administrator/)
    expect(oidcConfigFrom({ ...base, allow_create: "on", default_role: "engineer" }, ROLES)).toMatchObject({ allow_create: true, default_role: "engineer" })
  })
})

describe("API tokens", () => {
  const id = "3804e252-9833-4f01-84a0-2ac7586441d5"
  it("parses the create form", () => {
    expect(tokenInputFrom({ name: "HR sync", userId: id })).toEqual({ name: "HR sync", userId: id, expiresDays: null })
    expect(tokenInputFrom({ name: "x", userId: id, expiresDays: "90" }).expiresDays).toBe(90)
    expect(() => tokenInputFrom({ name: "x", userId: "me" })).toThrow(/acts as/)
    expect(() => tokenInputFrom({ userId: id })).toThrow(/Token name is required/)
    expect(() => tokenInputFrom({ name: "x", userId: id, expiresDays: "0" })).toThrow(/between 1 and 3650/)
  })
  it("refuses to give a token more permissions than its creator", () => {
    const admin = permissionsFor("admin")
    expect(isSubset(permissionsFor("engineer"), admin)).toBe(true)
    expect(isSubset(permissionsFor("superadmin"), admin)).toBe(false)
    expect(isSubset(permissionsFor("admin"), permissionsFor("engineer"))).toBe(false)
  })
})

describe("tenants and licence", () => {
  it("parses the create-tenant form", () => {
    const t = tenantInputFrom({ name: "Acme Ltd", timezone: "Asia/Kolkata", adminEmail: "Boss@Acme.com", adminName: "Boss" })
    expect(t).toEqual({ name: "Acme Ltd", slug: null, timezone: "Asia/Kolkata", adminEmail: "boss@acme.com", adminName: "Boss" })
    expect(tenantInputFrom({ name: "A", adminEmail: "a@b.c", adminName: "A" }).timezone).toBe("UTC")
    expect(() => tenantInputFrom({ name: "A", slug: "-bad", adminEmail: "a@b.c", adminName: "A" })).toThrow(/Slug/)
    expect(() => tenantInputFrom({ name: "A", timezone: "Mars/Olympus", adminEmail: "a@b.c", adminName: "A" })).toThrow(/time zone/)
    expect(() => tenantInputFrom({ name: "A", adminName: "A" })).toThrow(/email is required/)
  })
  it("cleans pasted licence text", () => {
    expect(licenseTextFrom("  ITSM-LICENSE-V1.abc\n.def \n")).toBe("ITSM-LICENSE-V1.abc.def")
    expect(() => licenseTextFrom("   ")).toThrow(/Paste/)
  })
})
