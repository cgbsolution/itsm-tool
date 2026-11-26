import { NextResponse, type NextRequest } from "next/server"
import { config } from "@/lib/config"
import { decryptSecret } from "@/lib/crypto"
import { discover, emailAllowed, loadProvider, oidc } from "@/lib/auth/oidc"
import { startSession, clientIp } from "@/lib/auth/session"
import { q1, exec } from "@/lib/db"
import { loadTenantSettings } from "@/lib/itsm/config"
import { auditSafe } from "@/lib/audit"
import { log } from "@/lib/log"

function fail(message: string) {
  const res = NextResponse.redirect(`${config.appUrl()}/login?error=${encodeURIComponent(message)}`)
  res.cookies.delete({ name: "itsm_oidc", path: "/api/auth/oidc" })
  return res
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const raw = req.cookies.get("itsm_oidc")?.value
  if (!raw) return fail("Your sign-in took too long. Try again.")
  let st: { id: string; verifier: string; state: string; nonce: string; next: string; exp: number }
  try {
    st = JSON.parse(decryptSecret(raw))
  } catch {
    return fail("Sign-in could not be verified. Try again.")
  }
  if (st.id !== id || st.exp < Date.now()) return fail("Your sign-in took too long. Try again.")

  try {
    const provider = await loadProvider(id)
    const conf = await discover(provider)
    // the URL the IdP redirected to, as the outside world sees it (behind a reverse proxy)
    const current = new URL(`${config.appUrl()}${req.nextUrl.pathname}${req.nextUrl.search}`)
    const tokens = await oidc.authorizationCodeGrant(conf, current, {
      pkceCodeVerifier: st.verifier,
      expectedState: st.state,
      expectedNonce: st.nonce,
      idTokenExpected: true,
    })
    const claims = tokens.claims()
    const email = String(claims?.email ?? claims?.preferred_username ?? "").toLowerCase()
    if (!email.includes("@")) return fail("Your identity provider did not send an email address")
    if (claims?.email_verified === false) return fail("Your email address is not verified at your identity provider")
    if (!emailAllowed(provider.config, email)) return fail("This sign-in option is not for your email domain")

    let user = await q1<{ id: string; tenant_id: string; status: string }>("select id, tenant_id, status from users where lower(email) = $1", [email])
    if (!user && provider.config.allow_create) {
      const role = provider.config.default_role && provider.config.default_role !== "superadmin" ? provider.config.default_role : "user"
      user = await q1<{ id: string; tenant_id: string; status: string }>(
        `insert into users (tenant_id, email, full_name, role, auth_source, external_id, status)
         values ($1, $2, $3, $4, 'oidc', $5, 'active') on conflict do nothing returning id, tenant_id, status`,
        [provider.tenant_id, email, String(claims?.name ?? email).slice(0, 200), role, String(claims?.sub ?? "")]
      )
      if (user) await auditSafe({ tenantId: provider.tenant_id, actor: { id: user.id, email }, action: "auth.user_provisioned", entityType: "user", entityId: user.id, summary: `Created at first sign-in via ${provider.name}` })
    }
    if (!user) return fail("There is no account for you yet. Ask your administrator.")
    if (user.tenant_id !== provider.tenant_id) return fail("This sign-in option is not for your account")
    if (user.status !== "active") return fail("Your account is not active")

    await exec("update users set last_login_at = now(), failed_logins = 0 where id = $1", [user.id])
    const settings = await loadTenantSettings(user.tenant_id)
    // the identity provider is responsible for MFA for these accounts
    await startSession(user.id, { mfaPending: false, hours: settings.session_hours })
    await auditSafe({ tenantId: user.tenant_id, actor: { id: user.id, email }, action: "auth.login", entityType: "user", entityId: user.id, summary: `via ${provider.name}`, ip: await clientIp() })
    const next = st.next.startsWith("/") && !st.next.startsWith("//") ? st.next : "/"
    const res = NextResponse.redirect(`${config.appUrl()}${next}`)
    res.cookies.delete({ name: "itsm_oidc", path: "/api/auth/oidc" })
    return res
  } catch (err) {
    log.warn("auth.oidc_callback_failed", { provider: id, err })
    return fail("Single sign-on failed. Try again or use your password.")
  }
}
