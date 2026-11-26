"use client"
/** Create-token form that shows the new token once, with a copy button. */
import { startTransition, useActionState, useEffect, useRef, useState } from "react"
import { createTokenAction, type CreateTokenState } from "./actions"

export function CreateTokenForm({ users, selfId }: { users: { id: string; label: string }[]; selfId: string | null }) {
  const [state, dispatch, pending] = useActionState<CreateTokenState, FormData>(createTokenAction, null)
  const [copied, setCopied] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.token) formRef.current?.reset()
  }, [state])
  return (
    <div className="space-y-3">
      {state?.token && (
        <div role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
          <p className="font-medium">Token created. Copy it now: it will not be shown again.</p>
          <div className="mt-2 flex gap-2">
            <input readOnly value={state.token} className="input font-mono text-xs" aria-label="New API token" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(state.token!).then(() => setCopied(true))
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      <form
        ref={formRef}
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          setCopied(false)
          startTransition(() => dispatch(fd))
        }}
      >
        <fieldset disabled={pending} className="contents">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="token-name">
              Name <span className="text-red-600">*</span>
            </label>
            <input id="token-name" name="name" required maxLength={100} className="input" placeholder="HR sync, monitoring…" />
          </div>
          <div>
            <label className="label" htmlFor="token-user">
              Acts as
            </label>
            <select id="token-user" name="userId" className="input" defaultValue={selfId ?? users[0]?.id ?? ""} required>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === selfId ? `Me (${u.label})` : u.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="token-expiry">
              Expires after (days)
            </label>
            <input id="token-expiry" name="expiresDays" type="number" min={1} max={3650} className="input" placeholder="Never" />
          </div>
          <div className="sm:col-span-4">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? "Creating…" : "Create token"}
            </button>
          </div>
        </fieldset>
      </form>
      {state?.error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
          {state.error}
        </p>
      )}
    </div>
  )
}
