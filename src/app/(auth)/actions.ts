"use server"
import { redirect } from "next/navigation"
import { q1, exec, tx } from "@/lib/db"
import { fail, ok, type FormState } from "@/lib/actions"
import { passwordLogin } from "@/lib/auth/login"
import { clientIp, completeMfa, endSession, getSession, revokeUserSessions, startSession, requireActor } from "@/lib/auth/session"
import { verifyTotp, generateTotpSecret, generateRecoveryCodes } from "@/lib/auth/totp"
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "@/lib/crypto"
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password"
import { loadTenantSettings } from "@/lib/itsm/config"
import { audit, auditSafe } from "@/lib/audit"
import { enforce } from "@/lib/rate-limit"
import { queueEmail } from "@/lib/email/send"
import { config } from "@/lib/config"
import { AppError } from "@/lib/errors"

function safeNext(next: unknown): string {
  const n = typeof next === "string" ? next : ""
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/"
}

export async function loginAction(_: FormState, fd: FormData): Promise<FormState> {
  const ip = await clientIp()
  let target = "/"
  try {
    const result = await passwordLogin(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""), ip)
    if (!result.ok) return { error: result.error }
    const settings = await loadTenantSettings(result.tenantId)
    await startSession(result.userId, { mfaPending: result.mfaEnabled, hours: settings.session_hours })
    await auditSafe({ tenantId: result.tenantId, actor: { id: result.userId }, action: "auth.login", entityType: "user", entityId: result.userId, ip })
    target = result.mfaEnabled ? `/login/mfa?next=${encodeURIComponent(safeNext(fd.get("next")))}` : safeNext(fd.get("next"))
  } catch (e) {
    return fail(e)
  }
  redirect(target)
}

export async function mfaAction(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession()
  if (!session) redirect("/login")
  try {
    await enforce(`mfa:${session.actor.id}`, 10, 600)
    const user = await q1<{ mfa_secret_enc: string | null; mfa_recovery_hashes: string[] }>(
      "select mfa_secret_enc, mfa_recovery_hashes from users where id = $1",
      [session.actor.id]
    )
    const code = String(fd.get("code") ?? "").trim()
    let okCode = false
    if (user?.mfa_secret_enc && /^\d{6}$/.test(code.replace(/\s/g, ""))) {
      okCode = verifyTotp(decryptSecret(user.mfa_secret_enc), code)
    } else if (user && /^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(code)) {
      const h = sha256Hex(code.toLowerCase())
      if (user.mfa_recovery_hashes.includes(h)) {
        okCode = true
        await exec("update users set mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $2) where id = $1", [session.actor.id, h])
        await auditSafe({ tenantId: session.actor.tenantId, actor: { id: session.actor.id }, action: "auth.mfa_recovery_code_used", entityType: "user", entityId: session.actor.id })
      }
    }
    if (!okCode) {
      await auditSafe({ tenantId: session.actor.tenantId, actor: { id: session.actor.id }, action: "auth.mfa_failed", entityType: "user", entityId: session.actor.id, ip: await clientIp() })
      return { error: "That code is not right. Try the current code from your authenticator app." }
    }
    await completeMfa(session.actor.sessionId)
  } catch (e) {
    return fail(e)
  }
  redirect(safeNext(fd.get("next")))
}

export async function logoutAction(): Promise<void> {
  const s = await getSession()
  if (s) await auditSafe({ tenantId: s.actor.tenantId, actor: { id: s.actor.id }, action: "auth.logout", entityType: "user", entityId: s.actor.id })
  await endSession()
  redirect("/login")
}

const GENERIC_RESET = "If that email belongs to an account with a password, a reset link is on its way."

export async function requestResetAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const email = String(fd.get("email") ?? "").trim().toLowerCase()
    const ip = await clientIp()
    await enforce(`reset:ip:${ip ?? "unknown"}`, 10, 3600)
    await enforce(`reset:acct:${email}`, 3, 3600)
    const user = await q1<{ id: string; tenant_id: string; status: string; auth_source: string }>(
      "select id, tenant_id, status, auth_source from users where lower(email) = $1",
      [email]
    )
    if (user && user.status === "active" && user.auth_source === "local") {
      const token = randomToken(32)
      await tx(async (db) => {
        await exec("insert into auth_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, 'reset', now() + interval '2 hours')", [sha256Hex(token), user.id], db)
        const u = await q1<{ email: string; full_name: string }>("select email, full_name from users where id = $1", [user.id], db)
        await queueEmail(
          { tenantId: user.tenant_id, to: u!.email, template: "user.password_reset", vars: { link: `${config.appUrl()}/reset/${token}`, hours: 2, recipient: { name: u!.full_name || u!.email } } },
          db
        )
      })
      await auditSafe({ tenantId: user.tenant_id, actor: { id: user.id }, action: "auth.reset_requested", entityType: "user", entityId: user.id, ip })
    }
    return ok(GENERIC_RESET)
  } catch (e) {
    if (e instanceof AppError && e.status === 429) return fail(e)
    return ok(GENERIC_RESET)
  }
}

export async function setPasswordWithTokenAction(token: string, _: FormState, fd: FormData): Promise<FormState> {
  try {
    const password = String(fd.get("password") ?? "")
    if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords do not match" }
    const row = await q1<{ user_id: string; purpose: string; email: string; tenant_id: string }>(
      `select t.user_id, t.purpose, u.email, u.tenant_id from auth_tokens t join users u on u.id = t.user_id
        where t.token_hash = $1 and t.used_at is null and t.expires_at > now()`,
      [sha256Hex(token)]
    )
    if (!row) return { error: "This link has expired or was already used. Ask for a new one." }
    const settings = await loadTenantSettings(row.tenant_id)
    const problem = passwordProblem(password, settings.password_min_length, row.email)
    if (problem) return { error: problem }
    await tx(async (db) => {
      await exec(
        `update users set password_hash = $2, password_changed_at = now(), must_change_password = false, failed_logins = 0,
                locked_until = null, status = case when status = 'invited' then 'active' else status end, auth_source = 'local'
          where id = $1`,
        [row.user_id, await hashPassword(password)],
        db
      )
      await exec("update auth_tokens set used_at = now() where token_hash = $1", [sha256Hex(token)], db)
      await exec("delete from sessions where user_id = $1", [row.user_id], db)
      await audit({ tenantId: row.tenant_id, actor: { id: row.user_id, email: row.email }, action: row.purpose === "invite" ? "auth.invite_accepted" : "auth.password_reset", entityType: "user", entityId: row.user_id }, db)
    })
  } catch (e) {
    return fail(e)
  }
  redirect("/login?flash=" + encodeURIComponent("Password set. Sign in with your new password."))
}

export async function changePasswordAction(_: FormState, fd: FormData): Promise<FormState> {
  const s = await getSession()
  if (!s || s.mfaPending) redirect("/login")
  const actor = s.actor
  try {
    const current = String(fd.get("current") ?? "")
    const password = String(fd.get("password") ?? "")
    if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords do not match" }
    const u = await q1<{ password_hash: string | null; auth_source: string }>("select password_hash, auth_source from users where id = $1", [actor.id])
    if (u?.auth_source !== "local") return { error: "Your password is managed by your organisation's directory" }
    if (!(await verifyPassword(current, u.password_hash))) return { error: "Your current password is not right" }
    if (current === password) return { error: "Choose a password you have not used here" }
    const settings = await loadTenantSettings(actor.homeTenantId)
    const problem = passwordProblem(password, settings.password_min_length, actor.email)
    if (problem) return { error: problem }
    await exec("update users set password_hash = $2, password_changed_at = now(), must_change_password = false where id = $1", [actor.id, await hashPassword(password)])
    await revokeUserSessions(actor.id, actor.sessionId)
    await auditSafe({ tenantId: actor.homeTenantId, actor: { id: actor.id, email: actor.email }, action: "auth.password_changed", entityType: "user", entityId: actor.id })
  } catch (e) {
    return fail(e)
  }
  redirect("/?flash=" + encodeURIComponent("Password changed"))
}

/* ── MFA enrolment ─────────────────────────────────────────────────────── */

export async function confirmMfaAction(_: FormState, fd: FormData): Promise<FormState> {
  const s = await getSession()
  if (!s || s.mfaPending) redirect("/login")
  const actor = s.actor
  try {
    const u = await q1<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>("select mfa_secret_enc, mfa_enabled from users where id = $1", [actor.id])
    if (u?.mfa_enabled) return { error: "Two-step sign-in is already on" }
    if (!u?.mfa_secret_enc) return { error: "Start the setup again" }
    if (!verifyTotp(decryptSecret(u.mfa_secret_enc), String(fd.get("code") ?? ""))) return { error: "That code is not right. Check the time on your phone and try again." }
    const codes = generateRecoveryCodes()
    await exec("update users set mfa_enabled = true, mfa_recovery_hashes = $2 where id = $1", [actor.id, codes.map((c) => sha256Hex(c))])
    await auditSafe({ tenantId: actor.homeTenantId, actor: { id: actor.id, email: actor.email }, action: "auth.mfa_enabled", entityType: "user", entityId: actor.id })
    return ok(`Two-step sign-in is on. Save these one-time recovery codes somewhere safe: ${codes.join("  ")}`)
  } catch (e) {
    return fail(e)
  }
}

export async function disableMfaAction(_: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireActor()
  try {
    if (actor.tenant.requireMfa) return { error: "Your organisation requires two-step sign-in" }
    const u = await q1<{ password_hash: string | null; auth_source: string }>("select password_hash, auth_source from users where id = $1", [actor.id])
    if (u?.auth_source === "local" && !(await verifyPassword(String(fd.get("current") ?? ""), u.password_hash))) return { error: "Your password is not right" }
    await exec("update users set mfa_enabled = false, mfa_secret_enc = null, mfa_recovery_hashes = '{}' where id = $1", [actor.id])
    await auditSafe({ tenantId: actor.homeTenantId, actor: { id: actor.id, email: actor.email }, action: "auth.mfa_disabled", entityType: "user", entityId: actor.id })
    return ok("Two-step sign-in is off")
  } catch (e) {
    return fail(e)
  }
}
