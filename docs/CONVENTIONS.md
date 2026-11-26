# Code conventions

Read this before adding a module. The ticket module is the reference implementation:
`src/lib/itsm/tickets.ts` (service), `src/lib/itsm/queries.ts` (read side),
`src/app/(app)/tickets/**` (pages + `actions.ts`). Copy its patterns.

**Next.js 16 note:** `next dev` writes `AGENTS.md`: APIs differ from older Next versions.
Version-matched docs are in `node_modules/next/dist/docs/`. In this version `params` and
`searchParams` are Promises, `cookies()`/`headers()` are async, and `middleware.ts` is called `proxy.ts`
(this app does not use one).

## Stack and layout

- Next.js 16 App Router, React 19, TypeScript strict, Tailwind 4. Server components by default.
- PostgreSQL through `pg`. **The browser never queries the database.** Pages and server actions
  call service functions in `src/lib/<module>/`.
- `db/migrations/NNNN_name.sql`: plain SQL, applied in order by `src/lib/db/migrate.ts` (also at
  app start). Never edit an applied migration; add a new file.
- `src/lib/<module>/` holds services (writes), queries (reads) and pure helpers.
- `src/app/(app)/<module>/` holds pages for signed-in users, plus `actions.ts` for server actions.
- `src/app/api/` holds route handlers for the REST API, the agent API, exports and downloads.
- `tests/unit/*.test.ts` (vitest, pure logic) and `tests/integration/*.test.ts` (real database; see
  `tests/integration/tickets.test.ts`).

## Database

```ts
import { q, q1, exec, tx, Params, isUuid, type Db } from "@/lib/db"
const rows = await q<Row>("select … where tenant_id = $1 and id = $2", [actor.tenantId, id])
const one  = await q1<Row>(…)          // first row or null
const n    = await exec("update …", […])   // affected rows
await tx(async (db) => { …; await q(…, […], db) })   // pass `db` to every call inside
```
- **Every query on tenant data filters on `tenant_id = actor.tenantId`**, including lookups by id
  (`where id = $1 and tenant_id = $2`). There is no RLS; this is the isolation boundary.
- Values only go in as parameters (`$1`). Build dynamic filters with `const p = new Params(); where.push(\`x = ${p.add(v)}\`)`.
- A `PoolClient` from `tx()` runs one query at a time: **no `Promise.all` on a transaction client.**
  `Promise.all` on the default pool is fine.
- `numeric` and `bigint` come back as JS numbers, `date` as `'YYYY-MM-DD'` strings, and
  `timestamptz` as `Date`.
- Unique violations: `isUniqueViolation(err)` → throw a friendly `AppError`.

## Who is acting

```ts
import { requireActor, requirePermission, can, type Actor } from "@/lib/auth/session"
const actor = await requirePermission("cmdb.edit")   // pages + actions: redirects to /login or /denied
if (can(actor, "cmdb.delete")) …
```
- `Actor` provides `id, email, name, tenantId, tenant {name, brandName, timezone, …}, permissions:
  Set<Permission>, groupIds, isSuperadmin`.
- Permission keys are in `src/lib/auth/permissions.ts` (do not add new keys without saying so).
- Show times in `actor.tenant.timezone` (`formatDateTime(d, tz)`, `<When value tz/>`).
- Background jobs use `systemActor(tenantId)` from `src/lib/auth/system.ts`. When storing actor
  ids, use `actorId(actor)` (null for the system).
- **Services re-check permissions themselves.** A page hiding a button is not security.

## Errors

`throw new AppError("Message the user can read", 400)`, or `notFound()` / `forbidden()` / `conflict()`
from `@/lib/errors`. Any other error is logged and shown as a generic message.

## Server actions and forms

```ts
// src/app/(app)/things/actions.ts
"use server"
export async function saveThing(id: string, _: FormState, fd: FormData): Promise<FormState> {
  const actor = await requirePermission("things.edit")
  try {
    await updateThing(actor, id, { name: str(fd.get("name"), 200) })
  } catch (e) {
    return fail(e)
  }
  revalidatePath(`/things/${id}`)     // refreshes the page data
  return ok("Saved")                  // or redirect(...) — outside the try
}
```
```tsx
<ActionForm action={saveThing.bind(null, id)} className="space-y-3" resetOnSuccess? confirm="Sure?">
  <input name="name" className="input" />
  <SubmitButton>Save</SubmitButton>
</ActionForm>
```
- Import `FormState, fail, ok` from `@/lib/actions`, `ActionForm, SubmitButton` from `@/components/client`.
- **Every export of a `"use server"` file is a public endpoint.** Export only actions that
  authenticate and authorise. Helpers go in `src/lib`.
- Parse input with `formObject(fd)`, `str()`, `int()`, `bool()`, `parseLocalDateTime(v, tz)`, or a zod schema
  with `parse(schema, input)` (all from `@/lib/validate`).
- Small inline actions can live in a page file with `"use server"` inside the function (see
  `src/app/(app)/approvals/page.tsx`).
- After a delete, `redirect("/list?flash=" + encodeURIComponent("Deleted"))`. The layout shows `?flash=`.

## UI

- Primitives are in `src/components/ui.tsx`: `PageHeader` (title, subtitle, actions, back), `Card`
  (title, actions), `Badge` (tone), `StatusBadge`, `PriorityBadge`, `Field`, `EmptyState`, `Stat`,
  `Tabs`, `Pagination`, `KeyValues`, `When`, and `qs()` for filter links.
- Client components are in `src/components/client.tsx`: `ActionForm`, `SubmitButton`, `CategoryPicker`,
  `PriorityPicker`. Write new client components only when needed, with `"use client"`, in the module folder.
- CSS classes: `btn btn-primary btn-danger btn-ghost btn-sm`, `input`, `label`, `hint`, `card card-body`,
  `table`, `badge`, `muted`, `prose-plain` (pre-wrapped user text), and `md` (rendered Markdown).
  Tailwind utilities are fine. Brand colour is `bg-brand` / `text-brand`.
- Lists use a GET `<form>` for filters (no client state), a `table` in a `card`, and `Pagination`.
- Never render user HTML. Render user text as text (`prose-plain`). Markdown goes through the safe
  renderer in `src/lib/kb/markdown.ts`.
- The sidebar links already exist (`src/app/(app)/layout.tsx`): `/cmdb`, `/endpoints`, `/patches`,
  `/patches/deployments`, `/catalog`, `/kb`, `/reports`, `/reports/audit`, `/admin`,
  `/changes/calendar`, `/search`.

## Cross-cutting services

- **Audit:** `await audit({ tenantId, actor: { id, email }, action: "cmdb.ci_deleted", entityType: "ci", entityId, summary, data }, db)`.
  Use it for deletes, permission/role/setting changes, approvals, scripts run, imports and licence changes.
- **Notifications:** `notify({ tenantId, recipients: [userIds], actorId, kind, title, body, link, entityType, entityId, email? }, db)`.
- **Jobs:** `enqueue(kind, payload, { runAt, dedupeKey }, db)`. Handlers and schedules are registered with
  `registerHandler(kind, fn)` / `registerSchedule(kind, seconds)` from `@/lib/jobs/worker`. Each module
  exports a `registerXJobs()` function, which is called from `src/lib/jobs/handlers.ts`.
- **Files:** `saveUploads(fd.getAll("files"), { tenantId, entityType, entityId, uploadedBy }, db)` or
  `saveBuffer(...)`. Content type is sniffed and executables are refused for attachments; pass
  `kind: "package"` for patch packages. Downloads go through `/api/files/[id]`, which checks access per
  `entity_type`.
- **Tickets from other modules:** call `createTicket(actor, input, db)`, `linkCi`, etc. from
  `@/lib/itsm/tickets`. Never write to `tickets` directly.
- **Route handlers:** `apiActor(req)` (session cookie or `Bearer itsm_pat_…` API token, with CSRF origin
  check on writes), `requirePerm(actor, perm)`, `json()`, `apiError(e)`, `csvResponse(name, header, rows)`
  from `@/lib/api`.

## Checking your work

- `npx tsc --noEmit` must pass.
- `npx vitest run tests/unit/<yours>.test.ts` must pass.
- A dev server runs at http://localhost:3100 against the test database. Fetch pages signed in as a
  super admin with `curl -H "Cookie: itsm_session=smoke-test-token-123" http://localhost:3100/<path>`.
  The server log shows errors. Do not start or stop servers.
- To apply a new migration to the test database:
  `DATABASE_URL=postgres://itsm:itsm_dev_password@localhost:5544/itsm_test npx tsx scripts/migrate.ts`.
