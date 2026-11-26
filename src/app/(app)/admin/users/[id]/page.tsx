import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { requirePermission } from "@/lib/auth/session"
import { AppError } from "@/lib/errors"
import { getUserDetail, manageProblem, peopleOptions, roleCatalog } from "@/lib/admin/users"
import { organizationOptions } from "@/lib/admin/organizations"
import { groupOptions, GROUP_KIND_LABELS } from "@/lib/admin/groups"
import { formatDateTime } from "@/lib/format"
import { ActionForm, SubmitButton } from "@/components/client"
import { Badge, Card, Field, KeyValues, PageHeader } from "@/components/ui"
import { AuthSourceBadge, UserDetailFields, UserStatusBadge } from "../form"
import {
  resetMfaAction,
  sendPasswordLinkAction,
  setEnabledAction,
  setGroupsAction,
  setRoleAction,
  signOutEverywhereAction,
  unlockAction,
  updateUserAction,
} from "../actions"

export const metadata = { title: "User" }

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("admin.users")
  const { id } = await params
  let detail
  try {
    detail = await getUserDetail(actor, id)
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound()
    throw e
  }
  const { user: u, groupIds, activeSessions } = detail
  const [roles, people, orgs, groups] = await Promise.all([roleCatalog(actor), peopleOptions(actor), organizationOptions(actor), groupOptions(actor)])
  const self = u.id === actor.id
  const problem = manageProblem(actor, u.role, roles)
  const canChange = !problem
  const local = u.auth_source === "local"
  const tz = actor.tenant.timezone
  const role = roles.find((r) => r.key === u.role)
  const offered = roles.filter((r) => r.grantable || r.key === u.role)
  const accountFacts: [ReactNode, ReactNode][] = [
    ["Created", formatDateTime(u.created_at, tz)],
    ["Last sign-in", u.last_login_at ? formatDateTime(u.last_login_at, tz) : "Never"],
    ["Last seen", u.last_seen_at ? formatDateTime(u.last_seen_at, tz) : "—"],
  ]
  if (local) accountFacts.push(["Password set", u.has_password ? (u.password_changed_at ? formatDateTime(u.password_changed_at, tz) : "Yes") : "Not yet"])
  if (u.must_change_password) accountFacts.push(["Password", "Must change at next sign-in"])
  accountFacts.push(["Failed sign-ins", String(u.failed_logins)])
  if (u.locked && u.locked_until) accountFacts.push(["Locked until", formatDateTime(u.locked_until, tz)])
  accountFacts.push(["Active sessions", String(activeSessions)])
  if (u.external_id) accountFacts.push(["External ID", <span className="font-mono text-xs break-all">{u.external_id}</span>])

  return (
    <>
      <PageHeader
        title={u.full_name || u.email}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {u.email}
            <UserStatusBadge status={u.status} />
            <AuthSourceBadge source={u.auth_source} />
            {u.mfa_enabled && <Badge tone="green">Two-step on</Badge>}
            {u.locked && <Badge tone="red">Locked out</Badge>}
            {self && <Badge>You</Badge>}
          </span>
        }
        back={{ href: "/admin/users", label: "Users" }}
      />
      {problem && <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">{problem}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Card title="Details">
            {canChange ? (
              <ActionForm action={updateUserAction.bind(null, u.id)} className="space-y-3">
                <UserDetailFields defaults={u} people={people} organizations={orgs} emailEditable={local} selfId={u.id} />
                <SubmitButton>Save details</SubmitButton>
              </ActionForm>
            ) : (
              <KeyValues
                items={[
                  ["Department", u.department],
                  ["Designation", u.designation],
                  ["Phone", u.phone],
                  ["Manager", u.manager_name],
                  ["Organisation", u.organization_name],
                ]}
              />
            )}
          </Card>

          <Card title="Groups">
            {groups.length === 0 ? (
              <p className="text-sm text-slate-500">This tenant has no groups yet.</p>
            ) : (
              <ActionForm action={setGroupsAction.bind(null, u.id)} className="space-y-3">
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="groups" value={g.id} defaultChecked={groupIds.includes(g.id)} className="mt-0.5" />
                      <span>
                        {g.name}
                        <span className="block text-xs text-slate-500">
                          {GROUP_KIND_LABELS[g.kind]}
                          {!g.is_active && " · inactive"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <SubmitButton className="btn">Save groups</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Role">
            {self || !canChange ? (
              <div className="space-y-1 text-sm">
                <div className="font-medium">{role?.name ?? u.role}</div>
                {role?.description && <p className="text-slate-500">{role.description}</p>}
                {self && <p className="hint">You cannot change your own role.</p>}
              </div>
            ) : (
              <ActionForm action={setRoleAction.bind(null, u.id)} className="space-y-2" confirm="Change the role? The person is signed out everywhere and gets the new permissions at next sign-in.">
                <Field label="Role" htmlFor="role" hint="Changing the role signs the person out everywhere.">
                  <select id="role" name="role" className="input" defaultValue={u.role}>
                    <optgroup label="Built-in roles">
                      {offered
                        .filter((r) => r.system)
                        .map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.name}
                          </option>
                        ))}
                    </optgroup>
                    {offered.some((r) => !r.system) && (
                      <optgroup label="Custom roles">
                        {offered
                          .filter((r) => !r.system)
                          .map((r) => (
                            <option key={r.key} value={r.key}>
                              {r.name}
                            </option>
                          ))}
                      </optgroup>
                    )}
                    {!role && <option value={u.role}>{u.role} (unknown role)</option>}
                  </select>
                </Field>
                <SubmitButton className="btn">Change role</SubmitButton>
              </ActionForm>
            )}
          </Card>

          <Card title="Account">
            <div className="space-y-3">
              <KeyValues items={accountFacts} />
              {canChange && !self && (
                <div className="border-t border-slate-100 pt-3">
                  {u.status === "disabled" ? (
                    <ActionForm action={setEnabledAction.bind(null, u.id, true)}>
                      <SubmitButton className="btn w-full">Enable account</SubmitButton>
                    </ActionForm>
                  ) : (
                    <ActionForm action={setEnabledAction.bind(null, u.id, false)} confirm={`Disable ${u.email}? They are signed out everywhere and cannot sign in until enabled again.`}>
                      <SubmitButton className="btn btn-danger w-full">Disable account</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              )}
            </div>
          </Card>

          {canChange && (
            <Card title="Sign-in security">
              <div className="space-y-2">
                {local && u.status !== "disabled" ? (
                  <ActionForm action={sendPasswordLinkAction.bind(null, u.id)} confirm={u.status === "invited" ? "Email a new invitation link?" : "Email a password reset link (valid for 2 hours)?"}>
                    <SubmitButton className="btn w-full">{u.status === "invited" ? "Resend invitation" : "Send password reset link"}</SubmitButton>
                  </ActionForm>
                ) : !local ? (
                  <p className="text-sm text-slate-500">
                    This account signs in with {u.auth_source === "ldap" ? "LDAP / Active Directory" : "single sign-on (OIDC)"}. Its password is managed there.
                  </p>
                ) : null}
                {u.mfa_enabled && !self && (
                  <ActionForm action={resetMfaAction.bind(null, u.id)} confirm="Reset two-step sign-in? Their authenticator app and recovery codes stop working.">
                    <SubmitButton className="btn w-full">Reset two-step sign-in</SubmitButton>
                  </ActionForm>
                )}
                {(u.locked || u.failed_logins > 0) && (
                  <ActionForm action={unlockAction.bind(null, u.id)}>
                    <SubmitButton className="btn w-full">Unlock{u.failed_logins > 0 ? ` (${u.failed_logins} failed attempt${u.failed_logins === 1 ? "" : "s"})` : ""}</SubmitButton>
                  </ActionForm>
                )}
                <ActionForm
                  action={signOutEverywhereAction.bind(null, u.id)}
                  confirm={self ? "Sign out of every other session?" : "Sign this person out of every session?"}
                >
                  <SubmitButton className="btn w-full">{self ? "Sign out my other sessions" : "Sign out everywhere"}</SubmitButton>
                </ActionForm>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
