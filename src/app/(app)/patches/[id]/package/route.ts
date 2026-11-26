/**
 * POST /patches/{id}/package: offline package upload (multipart, field "file").
 * A route handler rather than a server action so large update files (up to
 * 1 GB) are not limited by the server-action body size. Session + same-origin
 * check via apiActor; the service checks patch.approve. Redirects back to the
 * patch page with a flash or error message.
 */
import type { NextRequest } from "next/server"
import { apiActor } from "@/lib/api"
import { userMessage, AppError } from "@/lib/errors"
import { isUuid } from "@/lib/db"
import { log } from "@/lib/log"
import { attachPatchPackage } from "@/lib/endpoints/service"

function back(req: NextRequest, id: string, key: "flash" | "error", message: string) {
  const url = new URL(`/patches/${isUuid(id) ? id : ""}`, req.nextUrl.origin)
  url.searchParams.set(key, message)
  return new Response(null, { status: 303, headers: { Location: url.pathname + url.search, "Cache-Control": "no-store" } })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const actor = await apiActor(req)
    const fd = await req.formData()
    const file = fd.get("file")
    if (!file || typeof file === "string" || file.size === 0) throw new AppError("Choose a package file to upload")
    const r = await attachPatchPackage(actor, id, Buffer.from(await file.arrayBuffer()), file.name)
    return back(req, id, "flash", `Package uploaded (SHA-256 ${r.sha256.slice(0, 16)}…)`)
  } catch (e) {
    if (e instanceof AppError && e.status === 401) return new Response(null, { status: 303, headers: { Location: "/login" } })
    if (!(e instanceof AppError)) log.error("patch.package_upload_failed", { patch_id: id, err: e })
    return back(req, id, "error", userMessage(e))
  }
}
