import { describe, expect, it } from "vitest"
import { totp, verifyTotp, base32Decode, base32Encode, hotp } from "@/lib/auth/totp"
import { sniff, attachmentProblem, sanitizeFileName } from "@/lib/files/sniff"
import { escapeFilter } from "@/lib/auth/ldap"
import { passwordProblem, hashPassword, verifyPassword } from "@/lib/auth/password"
import { encryptSecret, decryptSecret } from "@/lib/crypto"
import { renderText, layoutHtml, textToHtml } from "@/lib/email/templates"
import { permissionsFor } from "@/lib/auth/permissions"

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 test secret "12345678901234567890" (ASCII) in base32
  const secret = base32Encode(Buffer.from("12345678901234567890"))
  it("matches the RFC test vector", () => {
    expect(hotp(base32Decode(secret), Math.floor(59 / 30))).toBe("287082")
    expect(totp(secret, 1111111109 * 1000)).toBe("081804")
  })
  it("accepts one step of drift and rejects garbage", () => {
    const now = Date.now()
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true)
    expect(verifyTotp(secret, "000000", now)).toBe(totp(secret, now) === "000000")
    expect(verifyTotp(secret, "abc", now)).toBe(false)
  })
})

describe("file sniffing", () => {
  it("detects real types from bytes, not names", () => {
    expect(sniff(Buffer.from("%PDF-1.7 ..."), "a.pdf").mime).toBe("application/pdf")
    expect(sniff(Buffer.from([0x4d, 0x5a, 0x90, 0]), "invoice.pdf").kind).toBe("executable")
    expect(sniff(Buffer.from("hello world\n"), "notes.txt").mime).toBe("text/plain")
  })
  it("refuses programs and scripts", () => {
    expect(attachmentProblem(sniff(Buffer.from([0x4d, 0x5a]), "x.pdf"), "x.pdf")).not.toBeNull()
    expect(attachmentProblem(sniff(Buffer.from("Write-Host hi"), "run.ps1"), "run.ps1")).not.toBeNull()
    expect(attachmentProblem(sniff(Buffer.from("#!/bin/sh\nrm -rf /"), "a.txt"), "a.txt")).not.toBeNull()
    expect(attachmentProblem(sniff(Buffer.from("log line"), "app.log"), "app.log")).toBeNull()
  })
  it("cleans file names", () => {
    expect(sanitizeFileName("..\\..\\windows\\system32\\evil.txt")).toBe("evil.txt")
    expect(sanitizeFileName("a<b>:c.txt")).toBe("a_b__c.txt")
  })
})

describe("LDAP filter escaping", () => {
  it("escapes RFC 4515 specials", () => {
    expect(escapeFilter("*)(uid=*")).toBe("\\2a\\29\\28uid=\\2a")
  })
})

describe("passwords", () => {
  it("rejects weak passwords", () => {
    expect(passwordProblem("short", 10)).toMatch(/at least/)
    expect(passwordProblem("password123", 10)).toMatch(/common/)
    expect(passwordProblem("alllowercaseletters", 10)).toBeNull() // 19 chars passphrase
    expect(passwordProblem("Tr0ub4dor&3x", 10)).toBeNull()
  })
  it("verifies bcrypt hashes, including $2a$ hashes from the old system", async () => {
    const h = await hashPassword("Correct-horse-1")
    expect(await verifyPassword("Correct-horse-1", h)).toBe(true)
    expect(await verifyPassword("wrong", h)).toBe(false)
    expect(await verifyPassword("x", "not-a-hash")).toBe(false)
    expect(await verifyPassword("x", h.replace(/^\$2b\$/, "$2a$"))).toBe(false)
    expect(await verifyPassword("Correct-horse-1", h.replace(/^\$2b\$/, "$2a$"))).toBe(true)
  })
})

describe("secret encryption", () => {
  it("round-trips and detects tampering", () => {
    const enc = encryptSecret("bind-password")
    expect(decryptSecret(enc)).toBe("bind-password")
    const parts = enc.split(".")
    parts[3] = Buffer.from("tampered").toString("base64url")
    expect(() => decryptSecret(parts.join("."))).toThrow()
  })
})

describe("email rendering", () => {
  it("escapes user text in HTML and drops empty placeholder lines", () => {
    const text = renderText("Hi {{recipient.name}}\n{{note}}\nBye", { recipient: { name: "<script>x</script>" } })
    expect(text).toBe("Hi <script>x</script>\nBye")
    const html = layoutHtml(textToHtml(text), { name: "Desk", color: "#123456" })
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })
  it("never puts line breaks into subjects", () => {
    expect(renderText("[{{n}}] {{s}}", { n: "INC1", s: "a\r\nBcc: x@y" }).replace(/[\r\n]+/g, " ")).not.toMatch(/\n/)
  })
})

describe("roles", () => {
  it("never grants tenant management to custom roles", () => {
    expect(permissionsFor("custom", ["admin.tenants", "ticket.work", "bogus"]).has("admin.tenants")).toBe(false)
    expect(permissionsFor("custom", ["ticket.work"]).has("ticket.work")).toBe(true)
    expect(permissionsFor("admin").has("admin.tenants")).toBe(false)
    expect(permissionsFor("admin").has("admin.license")).toBe(false) // installation-wide: super admin only
    expect(permissionsFor("custom", ["admin.license"]).has("admin.license")).toBe(false)
    expect(permissionsFor("superadmin").has("admin.tenants")).toBe(true)
  })
})
