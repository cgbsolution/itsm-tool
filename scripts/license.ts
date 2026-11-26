/**
 * Vendor tool for offline licences (keep the private key off customer servers).
 *   npm run license:keygen                       → keys/license-private.pem, keys/license-public.pem
 *   npm run license:issue -- --licensee "Acme" --devices 500 --days 365 [--modules itsm,cmdb,patch]
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { signLicense, type LicensePayload } from "@/lib/license"

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const cmd = process.argv[2]
const dir = path.resolve(arg("keys", "keys")!)

if (cmd === "keygen") {
  fs.mkdirSync(dir, { recursive: true })
  const priv = path.join(dir, "license-private.pem")
  if (fs.existsSync(priv)) {
    console.error(`${priv} already exists; not overwriting.`)
    process.exit(1)
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  fs.writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, "license-public.pem"), publicKey.export({ type: "spki", format: "pem" }))
  console.log(`Wrote ${priv} (keep secret) and license-public.pem (ship with the product).`)
} else if (cmd === "issue") {
  const licensee = arg("licensee")
  if (!licensee) {
    console.error('Usage: license:issue -- --licensee "Name" --devices 500 --days 365')
    process.exit(1)
  }
  const days = Number(arg("days", "365"))
  const payload: LicensePayload = {
    licensee,
    license_id: crypto.randomUUID(),
    issued_at: new Date().toISOString(),
    expires_at: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    max_devices: Number(arg("devices", "100")),
    modules: (arg("modules", "itsm,cmdb,patch") ?? "").split(",").filter(Boolean),
  }
  const text = signLicense(payload, fs.readFileSync(path.join(dir, "license-private.pem"), "utf8"))
  console.log(text)
} else {
  console.error("Commands: keygen | issue")
  process.exit(1)
}
