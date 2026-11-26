import { redirect } from "next/navigation"
import { ActionForm, SubmitButton } from "@/components/client"
import { changePasswordAction, logoutAction } from "../../actions"
import { getSession } from "@/lib/auth/session"

export const metadata = { title: "Change password" }

export default async function ChangePasswordPage() {
  const s = await getSession()
  if (!s) redirect("/login")
  if (s.mfaPending) redirect("/login/mfa")
  return (
    <>
      <h1 className="mb-1 text-center text-base">Change your password</h1>
      {s.actor.mustChangePassword && <p className="mb-4 text-center text-sm text-slate-500">You need to choose a new password before you continue.</p>}
      <ActionForm action={changePasswordAction} className="space-y-3">
        <div>
          <label className="label" htmlFor="current">Current password</label>
          <input id="current" name="current" type="password" autoComplete="current-password" required className="input" />
        </div>
        <div>
          <label className="label" htmlFor="password">New password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required className="input" />
        </div>
        <div>
          <label className="label" htmlFor="confirm">Repeat new password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" required className="input" />
        </div>
        <SubmitButton className="btn btn-primary w-full">Change password</SubmitButton>
      </ActionForm>
      <form action={logoutAction} className="mt-3 text-center">
        <button className="text-xs text-slate-500 hover:underline">Sign out</button>
      </form>
    </>
  )
}
