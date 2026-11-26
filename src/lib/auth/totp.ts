/**
 * TOTP (RFC 6238): 6 digits, 30-second steps, SHA-1, as used by common
 * authenticator apps. No external dependencies.
 */
import crypto from "node:crypto"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error("Invalid base32")
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac("sha1", secret).update(msg).digest()
  const offset = h[h.length - 1] & 0xf
  const code = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3]
  return String(code % 1_000_000).padStart(6, "0")
}

export function totp(secretBase32: string, at = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(at / 30_000))
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secretBase32: string, code: string, at = Date.now()): boolean {
  const c = code.replace(/\s+/g, "")
  if (!/^\d{6}$/.test(c)) return false
  const secret = base32Decode(secretBase32)
  const step = Math.floor(at / 30_000)
  for (const d of [-1, 0, 1]) {
    const expected = hotp(secret, step + d)
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true
  }
  return false
}

export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

/** One-time recovery codes (shown once; stored as sha256). */
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const raw = crypto.randomBytes(5).toString("hex")
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  })
}
