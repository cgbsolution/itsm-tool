/**
 * Copies the old helpdesk's attachment files from Supabase Storage into this
 * system's storage, for attachment records imported by import-legacy.ts.
 *
 *   LEGACY_SUPABASE_URL=https://<project>.supabase.co LEGACY_SUPABASE_SERVICE_KEY=... \
 *     npx tsx scripts/legacy/fetch-attachments.ts [--bucket ticket-attachments] [--dry-run]
 *
 * Run it once, from a machine that can reach the old project, BEFORE the old
 * project is shut down. The service key is read from the environment only and
 * never stored or printed. Files go through the same type checks as uploads;
 * refused files stay "not migrated" and are listed by id.
 */
import "../_env"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { pool, q, exec } from "@/lib/db"
import { storagePath } from "@/lib/files/storage"
import { attachmentProblem, sanitizeFileName, sniff } from "@/lib/files/sniff"

const bucket = process.argv.includes("--bucket") ? process.argv[process.argv.indexOf("--bucket") + 1] : "ticket-attachments"
const dry = process.argv.includes("--dry-run")

async function main() {
  const base = process.env.LEGACY_SUPABASE_URL?.replace(/\/+$/, "")
  const key = process.env.LEGACY_SUPABASE_SERVICE_KEY
  if (!base || !key) throw new Error("Set LEGACY_SUPABASE_URL and LEGACY_SUPABASE_SERVICE_KEY")
  const rows = await q<{ id: string; tenant_id: string; legacy_path: string; file_name: string }>(
    "select id, tenant_id, legacy_path, file_name from files where storage_key is null and legacy_path is not null order by created_at"
  )
  let copied = 0
  const refused: string[] = []
  for (const f of rows) {
    const objectPath = f.legacy_path.replace(/^\/+/, "").replace(new RegExp(`^${bucket}/`), "")
    const res = await fetch(`${base}/storage/v1/object/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    })
    if (!res.ok) {
      refused.push(`${f.id} (HTTP ${res.status})`)
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const name = sanitizeFileName(f.file_name)
    const sniffed = sniff(buf, name)
    const problem = attachmentProblem(sniffed, name)
    if (problem) {
      refused.push(`${f.id} (${problem})`)
      continue
    }
    if (dry) {
      copied++
      continue
    }
    const now = new Date()
    const storageKey = `${f.tenant_id}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}`
    const full = storagePath(storageKey)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, buf, { flag: "wx" })
    await exec(
      "update files set storage_key = $2, content_type = $3, size_bytes = $4, sha256 = $5 where id = $1",
      [f.id, storageKey, sniffed.mime, buf.length, crypto.createHash("sha256").update(buf).digest("hex")]
    )
    copied++
  }
  console.log(`${dry ? "Would copy" : "Copied"} ${copied} of ${rows.length} attachment file(s).`)
  if (refused.length) console.log(`Not copied (${refused.length}): ${refused.join(", ")}`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool().end())
