/**
 * File downloads with access checks per owning record. Files are always sent
 * as attachments with nosniff and a sandbox CSP, except safe image/PDF types
 * when ?inline=1 is asked for.
 */
import type { NextRequest } from "next/server"
import { q1, isUuid } from "@/lib/db"
import { apiActor, apiError } from "@/lib/api"
import { AppError, notFound } from "@/lib/errors"
import { readFileBytes } from "@/lib/files/storage"
import { inlineSafe } from "@/lib/files/sniff"
import { accessFor, type TicketRow } from "@/lib/itsm/tickets"
import { pool } from "@/lib/db"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await apiActor(req)
    const { id } = await params
    if (!isUuid(id)) throw notFound()
    const f = await q1<{ id: string; tenant_id: string; entity_type: string; entity_id: string | null; storage_key: string | null; file_name: string; content_type: string; uploaded_by: string | null; scan_status: string }>(
      "select id, tenant_id, entity_type, entity_id, storage_key, file_name, content_type, uploaded_by, scan_status from files where id = $1 and tenant_id = $2",
      [id, actor.tenantId]
    )
    if (!f) throw notFound()

    let allowed = false
    if (f.entity_type === "ticket" && f.entity_id) {
      const t = await q1<TicketRow>("select * from tickets where id = $1 and tenant_id = $2", [f.entity_id, actor.tenantId])
      allowed = !!t && (await accessFor(pool(), actor, t)).canView
    } else if (f.entity_type === "kb_article" && f.entity_id) {
      const a = await q1<{ status: string; visibility: string }>("select status, visibility from kb_articles where id = $1 and tenant_id = $2", [f.entity_id, actor.tenantId])
      allowed = !!a && (actor.permissions.has("kb.write") || (a.status === "published" && (a.visibility === "public" || actor.permissions.has("ticket.view_all"))))
    } else if (f.entity_type === "patch_package") {
      allowed = actor.permissions.has("endpoint.view")
    } else {
      allowed = f.uploaded_by === actor.id || actor.permissions.has("admin.settings")
    }
    if (!allowed) throw notFound()
    if (!f.storage_key) throw new AppError("This file's content was not migrated from the previous system", 410)
    if (f.scan_status === "infected") throw new AppError("This file was blocked by the virus scanner", 403)

    const buf = await readFileBytes(f.storage_key)
    const inline = req.nextUrl.searchParams.get("inline") === "1" && inlineSafe(f.content_type)
    const type = inline || inlineSafe(f.content_type) || f.content_type.startsWith("text/") ? f.content_type : "application/octet-stream"
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": type === "text/html" ? "text/plain" : type,
        "Content-Length": String(buf.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, no-store",
      },
    })
  } catch (e) {
    return apiError(e)
  }
}
