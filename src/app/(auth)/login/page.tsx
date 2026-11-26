import Link from "next/link"
import { redirect } from "next/navigation"
import { ActionForm, SubmitButton } from "@/components/client"
import { loginAction } from "../actions"
import { currentActor } from "@/lib/auth/session"
import { q } from "@/lib/db"

export const metadata = { title: "Sign in" }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await currentActor()) redirect("/")
  const { next } = await searchParams
  const oidc = await q<{ id: string; name: string }>("select id, name from auth_providers where kind = 'oidc' and enabled order by name")
  return (
    <>
      <h1 className="mb-4 text-center text-base">Sign in</h1>
      <ActionForm action={loginAction} className="space-y-3">
        <input type="hidden" name="next" value={next ?? "/"} />
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus className="input" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
        </div>
        <SubmitButton className="btn btn-primary w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      {oidc.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
          {oidc.map((p) => (
            <a key={p.id} href={`/api/auth/oidc/${p.id}/start?next=${encodeURIComponent(next ?? "/")}`} className="btn w-full">
              Sign in with {p.name}
            </a>
          ))}
        </div>
      )}
      <p className="mt-4 text-center text-xs">
        <Link href="/reset">Forgot your password?</Link>
      </p>
    </>
  )
}
