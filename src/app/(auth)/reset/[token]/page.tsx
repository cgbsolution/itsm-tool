import { ActionForm, SubmitButton } from "@/components/client"
import { setPasswordWithTokenAction } from "../../actions"
import { q1 } from "@/lib/db"
import { sha256Hex } from "@/lib/crypto"

export const metadata = { title: "Set password" }

export default async function SetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const row = await q1<{ purpose: string }>(
    "select purpose from auth_tokens where token_hash = $1 and used_at is null and expires_at > now()",
    [sha256Hex(token)]
  )
  if (!row) {
    return <p className="text-center text-sm text-slate-600">This link has expired or was already used. Ask for a new one.</p>
  }
  return (
    <>
      <h1 className="mb-4 text-center text-base">{row.purpose === "invite" ? "Welcome — choose a password" : "Choose a new password"}</h1>
      <ActionForm action={setPasswordWithTokenAction.bind(null, token)} className="space-y-3">
        <div>
          <label className="label" htmlFor="password">New password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required className="input" />
          <p className="hint">At least 10 characters. Mix letters with numbers or symbols, or use a long passphrase.</p>
        </div>
        <div>
          <label className="label" htmlFor="confirm">Repeat it</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" required className="input" />
        </div>
        <SubmitButton className="btn btn-primary w-full">Set password</SubmitButton>
      </ActionForm>
    </>
  )
}
