/**
 * Route-handler helpers: who is calling (session cookie or Bearer API token),
 * CSRF protection for cookie-authenticated writes, JSON error responses.
 */
import { NextResponse, type NextRequest } from "next/server"
import { q1, exec } from "@/lib/db"
import { sha256Hex } from "@/lib/crypto"
import { actorForUser, getSession, type Actor } from "@/lib/auth/session"
import { config } from "@/lib/config"
import { AppError } from "@/lib/errors"
import { log } from "@/lib/log"
import type { Permission } from "@/lib/auth/permissions"

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

export function apiError(err: unknown) {
  if (err instanceof AppError) return json({ error: err.message, code: err.code }, err.status)
  log.error("api.failed", { err })
  return json({ error: "Internal error" }, 500)
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site"
  try {
    const o = new URL(origin)
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
    return o.host === host || o.origin === new URL(config.appUrl()).origin
  } catch {
    return false
  }
}

/** The caller, or throws 401. API tokens look like `itsm_pat_…`. */
export async function apiActor(req: NextRequest): Promise<Actor> {
  const auth = req.headers.get("authorization")
  if (auth?.startsWith("Bearer itsm_pat_")) {
    const token = auth.slice(7).trim()
    const row = await q1<{ id: string; user_id: string; tenant_id: string }>(
      `select id, user_id, tenant_id from api_tokens
        where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
      [sha256Hex(token)]
    )
    if (!row) throw new AppError("Invalid API token", 401, "unauthorized")
    await exec("update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [row.id])
    const actor = await actorForUser(row.user_id, `token:${row.id}`)
    if (!actor || actor.homeTenantId !== row.tenant_id) throw new AppError("Invalid API token", 401, "unauthorized")
    return actor
  }
  const s = await getSession()
  if (!s || s.mfaPending) throw new AppError("Sign in first", 401, "unauthorized")
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) throw new AppError("Cross-site request refused", 403, "csrf")
  return s.actor
}

export function requirePerm(actor: Actor, perm: Permission) {
  if (!actor.permissions.has(perm)) throw new AppError("You do not have permission to do that", 403, "forbidden")
}

/** CSV with a UTF-8 BOM so Excel opens it correctly; formula-injection safe. */
export function csvResponse(filename: string, header: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
