/**
 * Personal access tokens for the REST API. The token is shown once; only its
 * SHA-256 and a short prefix (for recognising it in lists) are stored.
 */
import { q, q1, tx, isUuid } from "@/lib/db"
import type { Actor } from "@/lib/auth/session"
import { audit } from "@/lib/audit"
import { randomToken, sha256Hex } from "@/lib/crypto"
import { AppError, notFound } from "@/lib/errors"
import { need, auditActor, requestIp, permissionsOfUser } from "@/lib/sysadmin/guard"
import { isSubset, tokenInputFrom } from "@/lib/sysadmin/validate"

export const TOKEN_PREFIX = "itsm_pat_"

export type TokenRow = {
  id: string
  name: string
  prefix: string
  user_id: string
  user_name: string
  user_email: string
  created_at: Date
  last_used_at: Date | null
  expires_at: Date | null
  revoked_at: Date | null
}

export async function listTokens(actor: Actor): Promise<TokenRow[]> {
  need(actor, "admin.settings")
  return q<TokenRow>(
    `select k.id, k.name, k.prefix, k.user_id, coalesce(nullif(u.full_name, ''), u.email) as user_name, u.email as user_email,
            k.created_at, k.last_used_at, k.expires_at, k.revoked_at
       from api_tokens k join users u on u.id = k.user_id
      where k.tenant_id = $1
      order by k.revoked_at is not null, k.created_at desc`,
    [actor.tenantId]
  )
}

/** Active users of the current tenant a token may act as. */
export async function tokenUserOptions(actor: Actor) {
  need(actor, "admin.settings")
  return q<{ id: string; full_name: string; email: string; role: string }>(
    "select id, full_name, email, role from users where tenant_id = $1 and status = 'active' order by full_name, email limit 2000",
    [actor.tenantId]
  )
}

/** Creates a token and returns it in full (the only time it is available). */
export async function createToken(actor: Actor, input: Record<string, unknown>): Promise<{ id: string; token: string }> {
  need(actor, "admin.settings")
  const t = tokenInputFrom(input)
  const user = await q1<{ id: string; email: string; role: string }>(
    "select id, email, role from users where id = $1 and tenant_id = $2 and status = 'active'",
    [t.userId, actor.tenantId]
  )
  if (!user) throw new AppError("Choose an active user of this tenant")
  if (user.id !== actor.id) {
    // acting as someone else must not give the creator more than they already have
    if (user.role === "superadmin" && !actor.isSuperadmin) throw new AppError("Only a super administrator can create a token for a super administrator")
    if (!isSubset(await permissionsOfUser(actor.tenantId, user.role), actor.permissions))
      throw new AppError("That user has permissions you do not have, so you cannot create a token for them")
  }
  const token = TOKEN_PREFIX + randomToken(32)
  const prefix = token.slice(0, 12)
  const ip = await requestIp()
  const id = await tx(async (db) => {
    const row = await q1<{ id: string; expires_at: Date | null }>(
      `insert into api_tokens (tenant_id, user_id, name, token_hash, prefix, expires_at)
       values ($1, $2, $3, $4, $5, case when $6::int is null then null else now() + make_interval(days => $6::int) end)
       returning id, expires_at`,
      [actor.tenantId, user.id, t.name, sha256Hex(token), prefix, t.expiresDays],
      db
    )
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.api_token_created",
        entityType: "api_token",
        entityId: row!.id,
        summary: `API token "${t.name}" created, acting as ${user.email}`,
        data: { name: t.name, user_id: user.id, prefix, expires_at: row!.expires_at },
        ip,
      },
      db
    )
    return row!.id
  })
  return { id, token }
}

export async function revokeToken(actor: Actor, id: string): Promise<void> {
  need(actor, "admin.settings")
  if (!isUuid(id)) throw notFound("Token not found")
  const ip = await requestIp()
  await tx(async (db) => {
    const row = await q1<{ name: string; prefix: string }>(
      "update api_tokens set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null returning name, prefix",
      [id, actor.tenantId],
      db
    )
    if (!row) throw new AppError("That token is not active", 409)
    await audit(
      {
        tenantId: actor.tenantId,
        actor: auditActor(actor),
        action: "admin.api_token_revoked",
        entityType: "api_token",
        entityId: id,
        summary: `API token "${row.name}" revoked`,
        data: { prefix: row.prefix },
        ip,
      },
      db
    )
  })
}
