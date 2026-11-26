/**
 * GET /api/agent/v1/packages/{patch_id}: offline package download for
 * air-gapped installs (device bearer auth). Streams the file with
 * X-Content-SHA256 so the agent can verify it before installing.
 */
import fs from "node:fs"
import { Readable } from "node:stream"
import type { NextRequest } from "next/server"
import { packageForDevice } from "@/lib/endpoints/agent"
import { storagePath } from "@/lib/files/storage"
import { AppError } from "@/lib/errors"
import { withDevice } from "@/lib/endpoints/http"

export async function GET(req: NextRequest, { params }: { params: Promise<{ patch_id: string }> }) {
  return withDevice(req, async (device) => {
    const { patch_id } = await params
    const pkg = await packageForDevice(device, patch_id)
    const full = storagePath(pkg.storageKey)
    const stat = await fs.promises.stat(full).catch(() => null)
    if (!stat) throw new AppError("The package file is missing from storage", 404, "not_found")
    const stream = Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream<Uint8Array>
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(pkg.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    }
    if (pkg.sha256) headers["X-Content-SHA256"] = pkg.sha256
    return new Response(stream, { headers })
  })
}
