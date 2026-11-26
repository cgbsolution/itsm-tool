import Link from "next/link"
import { ActionForm, SubmitButton } from "@/components/client"
import { requestResetAction } from "../actions"

export const metadata = { title: "Reset password" }

export default function ResetPage() {
  return (
    <>
      <h1 className="mb-1 text-center text-base">Reset your password</h1>
      <p className="mb-4 text-center text-sm text-slate-500">We will email you a link to set a new password.</p>
      <ActionForm action={requestResetAction} className="space-y-3">
        <input name="email" type="email" required autoFocus className="input" placeholder="you@example.com" />
        <SubmitButton className="btn btn-primary w-full">Send reset link</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-xs">
        <Link href="/login">Back to sign in</Link>
      </p>
    </>
  )
}
