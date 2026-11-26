import Link from "next/link"
import { redirect } from "next/navigation"
import { ActionForm, SubmitButton } from "@/components/client"
import { confirmMfaAction, logoutAction } from "../../actions"
import { getSession } from "@/lib/auth/session"
import { pendingMfaSecret } from "@/lib/auth/mfa"
import { otpauthUrl } from "@/lib/auth/totp"

export const metadata = { title: "Set up two-step sign-in" }

export default async function MfaSetupPage() {
  const s = await getSession()
  if (!s) redirect("/login")
  if (s.mfaPending) redirect("/login/mfa")
  const secret = await pendingMfaSecret(s.actor.id)
  if (!secret) {
    return (
      <div className="text-center text-sm">
        <p>Two-step sign-in is on for your account.</p>
        <Link href="/" className="btn btn-primary mt-4">Continue</Link>
      </div>
    )
  }
  const url = otpauthUrl(secret, s.actor.email, s.actor.tenant.brandName)
  const grouped = secret.match(/.{1,4}/g)?.join(" ")
  return (
    <>
      <h1 className="mb-1 text-center text-base">Set up two-step sign-in</h1>
      {s.actor.tenant.requireMfa && <p className="mb-3 text-center text-sm text-slate-500">Your organisation requires it.</p>}
      <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm text-slate-700">
        <li>Open an authenticator app (Microsoft Authenticator, Google Authenticator, FreeOTP…).</li>
        <li>
          Add an account with this setup key (time-based):
          <div className="mt-1 rounded bg-slate-100 px-2 py-1 text-center font-mono text-sm tracking-wider select-all">{grouped}</div>
          <a href={url} className="text-xs">or open it in an authenticator on this device</a>
        </li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <ActionForm action={confirmMfaAction} className="space-y-3">
        <input name="code" inputMode="numeric" autoComplete="one-time-code" required className="input text-center text-lg tracking-widest" placeholder="123456" />
        <SubmitButton className="btn btn-primary w-full">Turn on</SubmitButton>
      </ActionForm>
      <div className="mt-3 flex justify-between text-xs">
        <Link href="/">Continue to the app</Link>
        <form action={logoutAction}>
          <button className="text-slate-500 hover:underline">Sign out</button>
        </form>
      </div>
    </>
  )
}
