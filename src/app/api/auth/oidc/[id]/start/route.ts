import { NextResponse, type NextRequest } from "next/server"
import { config } from "@/lib/config"
import { encryptSecret } from "@/lib/crypto"
import { discover, loadProvider, oidc } from "@/lib/auth/oidc"
import { log } from "@/lib/log"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const provider = await loadProvider(id)
    const conf = await discover(provider)
    const verifier = oidc.randomPKCECodeVerifier()
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const next = req.nextUrl.searchParams.get("next") ?? "/"
    const url = oidc.buildAuthorizationUrl(conf, {
      redirect_uri: `${config.appUrl()}/api/auth/oidc/${id}/callback`,
      scope: provider.config.scopes || "openid email profile",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    })
    const res = NextResponse.redirect(url)
    res.cookies.set("itsm_oidc", encryptSecret(JSON.stringify({ id, verifier, state, nonce, next, exp: Date.now() + 600_000 })), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure(),
      path: "/api/auth/oidc",
      maxAge: 600,
    })
    return res
  } catch (err) {
    log.warn("auth.oidc_start_failed", { provider: id, err })
    return NextResponse.redirect(`${config.appUrl()}/login?error=${encodeURIComponent("Single sign-on is not available right now")}`)
  }
}
