/**
 * File storage on local disk (STORAGE_DIR), metadata in `files`.
 * Keys are generated server-side: tenant/yyyy/mm/uuid. Nothing is served
 * directly from disk; downloads go through /api/files/[id] with access checks.
 */
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { q1, type Db, pool } from "@/lib/db"
import { config } from "@/lib/config"
import { AppError } from "@/lib/errors"
import { attachmentProblem, packageProblem, sanitizeFileName, sniff } from "@/lib/files/sniff"
import { scanBuffer } from "@/lib/files/clamav"

export type EntityType = "ticket" | "comment" | "kb_article" | "patch_package" | "import"

export function storagePath(key: string): string {
  const root = config.storageDir()
  const full = path.resolve(root, key)
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("Invalid storage key")
  return full
}

export type SavedFile = { id: string; file_name: string; content_type: string; size_bytes: number; sha256: string }

export async function saveBuffer(
  buf: Buffer,
  originalName: string,
  opts: { tenantId: string; entityType: EntityType; entityId: string | null; uploadedBy: string | null; kind?: "attachment" | "package" },
  db: Db = pool()
): Promise<SavedFile> {
  const name = sanitizeFileName(originalName)
  const max = opts.kind === "package" ? 1024 * 1024 * 1024 : config.maxUploadBytes()
  if (buf.length === 0) throw new AppError(`${name} is empty`)
  if (buf.length > max) throw new AppError(`${name} is larger than ${Math.round(max / 1024 / 1024)} MB`)
  const sniffed = sniff(buf, name)
  const problem = opts.kind === "package" ? packageProblem(name) : attachmentProblem(sniffed, name)
  if (problem) throw new AppError(`${name}: ${problem}`)
  const scan = await scanBuffer(buf)
  if (scan.result === "infected") throw new AppError(`${name} was rejected by the virus scanner`)

  const sha256 = crypto.createHash("sha256").update(buf).digest("hex")
  const now = new Date()
  const key = `${opts.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}`
  const full = storagePath(key)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, buf, { flag: "wx" })
  const row = await q1<SavedFile>(
    `insert into files (tenant_id, entity_type, entity_id, storage_key, file_name, content_type, size_bytes, sha256, scan_status, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id, file_name, content_type, size_bytes, sha256`,
    [opts.tenantId, opts.entityType, opts.entityId, key, name, opts.kind === "package" ? "application/octet-stream" : sniffed.mime, buf.length, sha256, scan.result, opts.uploadedBy],
    db
  )
  return row!
}

/** Saves the File objects of a form field (ignores empty file inputs). */
export async function saveUploads(
  files: FormDataEntryValue[],
  opts: { tenantId: string; entityType: EntityType; entityId: string | null; uploadedBy: string | null },
  db: Db = pool()
): Promise<SavedFile[]> {
  const list = files.filter((f): f is File => typeof f !== "string" && f.size > 0)
  if (list.length > 10) throw new AppError("Attach at most 10 files at a time")
  const saved: SavedFile[] = []
  for (const f of list) saved.push(await saveBuffer(Buffer.from(await f.arrayBuffer()), f.name, opts, db))
  return saved
}

export async function readFileBytes(key: string): Promise<Buffer> {
  return fs.readFile(storagePath(key))
}

export async function removeStored(key: string | null): Promise<void> {
  if (!key) return
  await fs.rm(storagePath(key), { force: true })
}
