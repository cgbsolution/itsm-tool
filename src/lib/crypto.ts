import crypto from "node:crypto"
import { config } from "@/lib/config"

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url")
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest()
  const hb = crypto.createHash("sha256").update(b).digest()
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length
}

function key(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", config.appSecret(), "itsm-platform", "secret-encryption-v1", 32))
}

/** Encrypts a secret for storage (AES-256-GCM). Format: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".")
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(".")
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unsupported secret format")
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8")
}

export function maybeDecrypt(enc: string | null | undefined): string | undefined {
  if (!enc) return undefined
  try {
    return decryptSecret(enc)
  } catch {
    return undefined
  }
}
