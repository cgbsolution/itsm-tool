import Link from "next/link"
import { revalidatePath } from "next/cache"
import { requireActor } from "@/lib/auth/session"
import { q, q1, exec } from "@/lib/db"
import { ActionForm, SubmitButton } from "@/components/client"
import { Card, KeyValues, PageHeader, When } from "@/components/ui"
import { disableMfaAction } from "../../(auth)/actions"
import { fail, ok, type FormState } from "@/lib/actions"
import { str } from "@/lib/validate"
import { isValidTimeZone } from "@/lib/itsm/clock"

export const metadata = { title: "Profile" }

async function saveProfile(_: FormState, fd: FormData): Promise<FormState> {
  "use server"
  const actor = await requireActor()
  try {
    const tz = str(fd.get("timezone"), 64)
    if (tz && !isValidTimeZone(tz)) return { error: "Unknown time zone" }
    await exec("update users set full_name = coalesce($2, full_name), phone = $3, timezone = $4, updated_at = now() where id = $1", [
      actor.id,
      str(fd.get("full_name"), 200),
      str(fd.get("phone"), 50),
      tz,
    ])
    revalidatePath("/profile")
    return ok("Saved")
  } catch (e) {
    return fail(e)
  }
}

async function signOutOthers(): Promise<FormState> {
  "use server"
  const actor = await requireActor()
  await exec("delete from sessions where user_id = $1 and id <> $2", [actor.id, actor.sessionId])
  revalidatePath("/profile")
  return ok("Signed out of all other sessions")
}

export default async function ProfilePage() {
  const actor = await requireActor()
  const [u, sessions] = await Promise.all([
    q1<{ full_name: string; email: string; phone: string | null; timezone: string | null; auth_source: string; mfa_enabled: boolean; last_login_at: Date | null; department: string | null; designation: string | null }>(
      "select full_name, email, phone, timezone, auth_source, mfa_enabled, last_login_at, department, designation from users where id = $1",
      [actor.id]
    ),
    q<{ id: string; created_at: Date; last_seen_at: Date; ip: string | null; user_agent: string | null }>(
      "select id, created_at, last_seen_at, ip, user_agent from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc",
      [actor.id]
    ),
  ])
  const tz = actor.tenant.timezone
  return (
    <>
      <PageHeader title="Profile & security" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Your details">
          <ActionForm action={saveProfile} className="space-y-3">
            <div>
              <label className="label" htmlFor="full_name">Name</label>
              <input id="full_name" name="full_name" defaultValue={u?.full_name} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="phone">Phone</label>
              <input id="phone" name="phone" defaultValue={u?.phone ?? ""} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="timezone">Time zone</label>
              <input id="timezone" name="timezone" defaultValue={u?.timezone ?? ""} placeholder={tz} className="input" />
            </div>
            <KeyValues items={[["Email", u?.email], ["Role", actor.roleName], ["Department", u?.department], ["Sign-in", u?.auth_source === "local" ? "Password" : u?.auth_source?.toUpperCase()]]} />
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </Card>
        <div className="space-y-4">
          <Card title="Sign-in security">
            <div className="space-y-3 text-sm">
              {u?.auth_source === "local" && (
                <p>
                  <Link href="/account/password" className="btn">Change password</Link>
                </p>
              )}
              <p>
                Two-step sign-in is <strong>{u?.mfa_enabled ? "on" : "off"}</strong>.
              </p>
              {u?.mfa_enabled ? (
                !actor.tenant.requireMfa && (
                  <ActionForm action={disableMfaAction} className="flex gap-2">
                    {u.auth_source === "local" && <input type="password" name="current" placeholder="Your password" className="input" required />}
                    <SubmitButton className="btn btn-danger">Turn off</SubmitButton>
                  </ActionForm>
                )
              ) : (
                <Link href="/account/mfa" className="btn btn-primary">Set up two-step sign-in</Link>
              )}
            </div>
          </Card>
          <Card title={`Active sessions (${sessions.length})`} actions={sessions.length > 1 && <ActionForm action={signOutOthers}><SubmitButton className="btn btn-sm">Sign out others</SubmitButton></ActionForm>}>
            <ul className="space-y-2 text-sm">
              {sessions.map((s) => (
                <li key={s.id} className="flex justify-between gap-2">
                  <span className="truncate text-slate-600">
                    {s.id === actor.sessionId && <strong>This device · </strong>}
                    {s.user_agent?.slice(0, 60) ?? "Unknown browser"} {s.ip ? `· ${s.ip}` : ""}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    <When value={s.last_seen_at} timeZone={tz} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  )
}
