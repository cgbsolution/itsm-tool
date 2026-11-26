/**
 * Offline licensing: a licence is a signed text block verified locally with
 * the vendor's Ed25519 public key. No phone-home, works air-gapped.
 *   ITSM-LICENSE-V1.<base64url(JSON payload)>.<base64url(signature)>
 * Without a valid licence the app runs in evaluation mode (device limit).
 * An expired licence never locks people out of the service desk; it blocks
 * new device enrolments only.
 */
import fs from "node:fs"
import crypto from "node:crypto"
import { q1 } from "@/lib/db"
import { config } from "@/lib/config"

export type LicensePayload = {
  licensee: string
  license_id: string
  issued_at: string
  expires_at: string | null
  max_devices: number
  modules: string[]
}

export const EVALUATION_DEVICE_LIMIT = 25

function publicKey(): crypto.KeyObject | null {
  try {
    const pem = config.licensePublicKeyPem() ?? (config.licensePublicKeyFile() && fs.existsSync(config.licensePublicKeyFile()!) ? fs.readFileSync(config.licensePublicKeyFile()!, "utf8") : null)
    return pem ? crypto.createPublicKey(pem) : null
  } catch {
    return null
  }
}

export function verifyLicenseText(text: string): { ok: true; payload: LicensePayload } | { ok: false; error: string } {
  const parts = text.trim().split(".")
  if (parts.length !== 3 || parts[0] !== "ITSM-LICENSE-V1") return { ok: false, error: "This is not a licence file" }
  const key = publicKey()
  if (!key) return { ok: false, error: "No licence public key is configured on this server (LICENSE_PUBLIC_KEY_FILE)" }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
  const valid = crypto.verify(null, signed, key, Buffer.from(parts[2], "base64url"))
  if (!valid) return { ok: false, error: "The licence signature is not valid" }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as LicensePayload
    return { ok: true, payload }
  } catch {
    return { ok: false, error: "The licence content is damaged" }
  }
}

export type LicenseStatus = {
  mode: "licensed" | "evaluation" | "expired" | "invalid"
  payload: LicensePayload | null
  maxDevices: number
  level: "ok" | "warn" | "error"
  banner: string | null
}

let cache: { at: number; value: LicenseStatus } | null = null

export async function licenseStatus(fresh = false): Promise<LicenseStatus> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value
  const row = await q1<{ license_text: string }>("select license_text from license where id = 1").catch(() => null)
  let value: LicenseStatus
  if (!row) {
    value = {
      mode: "evaluation",
      payload: null,
      maxDevices: EVALUATION_DEVICE_LIMIT,
      level: "warn",
      banner: `Evaluation mode: up to ${EVALUATION_DEVICE_LIMIT} managed devices. Install a licence in Administration › Licence.`,
    }
  } else {
    const v = verifyLicenseText(row.license_text)
    if (!v.ok) {
      value = { mode: "invalid", payload: null, maxDevices: EVALUATION_DEVICE_LIMIT, level: "error", banner: `Licence problem: ${v.error}. Running with evaluation limits.` }
    } else if (v.payload.expires_at && new Date(v.payload.expires_at).getTime() < Date.now()) {
      value = { mode: "expired", payload: v.payload, maxDevices: 0, level: "error", banner: `The licence expired on ${v.payload.expires_at.slice(0, 10)}. New devices cannot be enrolled.` }
    } else {
      const days = v.payload.expires_at ? Math.floor((new Date(v.payload.expires_at).getTime() - Date.now()) / 86_400_000) : null
      value = {
        mode: "licensed",
        payload: v.payload,
        maxDevices: v.payload.max_devices,
        level: days !== null && days < 30 ? "warn" : "ok",
        banner: days !== null && days < 30 ? `The licence expires in ${days} days.` : null,
      }
    }
  }
  cache = { at: Date.now(), value }
  return value
}

export function clearLicenseCache() {
  cache = null
}

/** Vendor side: signs a payload with the private key (scripts/license.ts). */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = `ITSM-LICENSE-V1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKeyPem))
  return `${body}.${sig.toString("base64url")}`
}
