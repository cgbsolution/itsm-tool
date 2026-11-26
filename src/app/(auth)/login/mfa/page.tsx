import { redirect } from "next/navigation"
import { ActionForm, SubmitButton } from "@/components/client"
import { mfaAction, logoutAction } from "../../actions"
import { getSession } from "@/lib/auth/session"

export const metadata = { title: "Two-step sign-in" }

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const s = await getSession()
  if (!s) redirect("/login")
  if (!s.mfaPending) redirect("/")
  const { next } = await searchParams
  return (
    <>
      <h1 className="mb-1 text-center text-base">Two-step sign-in</h1>
      <p className="mb-4 text-center text-sm text-slate-500">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
      <ActionForm action={mfaAction} className="space-y-3">
        <input type="hidden" name="next" value={next ?? "/"} />
        <input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus className="input text-center text-lg tracking-widest" placeholder="123456" />
        <SubmitButton className="btn btn-primary w-full">Verify</SubmitButton>
      </ActionForm>
      <form action={logoutAction} className="mt-3 text-center">
        <button className="text-xs text-slate-500 hover:underline">Cancel and sign out</button>
      </form>
    </>
  )
}
