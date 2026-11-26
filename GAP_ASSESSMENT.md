# CGB Helpdesk — Due-Diligence Gap Assessment (Phase 1: on-prem ITSM + native endpoint patching)

**Repository reviewed:** `E:\cgb-code\CGB-Helpdesk-latest` (branch `main`, HEAD `3e2b09f`, 2026-11-12). All paths below are relative to that root.
**Review date:** 2026-11-26. **Method:** read-only static review of the code, the git history, the SQL files and a schema-only production dump that was already on disk. Nothing was built, installed, run or connected to a database. `npm audit --package-lock-only` was the only tool run; it reads the lockfile and writes nothing.
**Labels:** **CONFIRMED** = seen in code or files (with path:line). **INFERRED** = engineering judgement. All effort figures are **estimates in person-weeks (pw)**, given as ranges.

---

## 1. Executive summary

1. **Recommendation: (c) Hybrid, which in practice means rewriting the platform and keeping the domain logic and the data.** Keep the ITSM domain code (SLA clock, priority matrix, categories, record types and numbering, ticket permission rules, notification routing, asset import) and migrate the 6-month dataset. Replace the platform layer (Supabase-cloud coupling, auth, jobs, storage, packaging). Build CMDB, workflow and the agent/patching stack new.
2. **Most of Phase 1 is new work.** The existing code covers about 7–12 pw of an estimated 114–193 pw Phase 1 (INFERRED). Section C (agent and patching) is 0% present.
3. **Critical security history.** In the production schema snapshot taken 2026-11-12 00:23, row-level security was off on `tickets`, `users`, `assets`, `ticket_messages` and `notifications`, and the public `anon` role had `GRANT ALL` on them. Anyone holding the public browser key could read and change all data (CONFIRMED, `backups/prod-20261112-002330-public-schema.sql:923-953, 1064-1145`). A fix was reportedly applied the same day. Whether it is live has not been verified.
4. **Platform lock-in.** The UI reads the database directly from the browser through Supabase PostgREST, with RLS acting as the API. It also depends on Supabase Auth, Realtime, Storage, pg_cron, pg_net and Vault. Hosting is Vercel (Hobby tier per `supabase/migration_sla_cron.sql:3`). No on-prem packaging exists.
5. **Fragile engineering base.** Zero automated tests, one author, no CI, and no `CREATE TABLE` for the base tables in the repo. The migration README does not match the production schema.
6. **The ITSM features are about two weeks old.** Record types, SLA policies, the priority matrix and tenancy landed on 2026-11-11/12 in two commits totalling about 10.9k lines added (CONFIRMED). The "6 months in production" experience mostly reflects the earlier, simpler helpdesk.
7. **Dependencies:** 23 audit findings (2 critical, 17 high), affecting the direct dependencies `next`, `nodemailer`, `xlsx`, `swiper` and `postcss`. There are two licence red flags (AGPL-or-commercial jvectormap, revenue-gated ApexCharts), both only in unused template code that can be deleted.

---

## 2. Codebase profile

### 2.1 Stack (CONFIRMED)

| Aspect | Finding | Evidence |
|---|---|---|
| Origin | Fork of the **TailAdmin** free Next.js admin template (MIT). README is still the template's. `package.json` name is still `free-nextjs-admin-dashboard` | `README.md:1-80`, `LICENSE:1-3`, `package.json:2-3` |
| Language / framework | TypeScript 5.9 (strict), Next.js **16.0.10** App Router, React 19.2 | `package.json`, `tsconfig.json` |
| UI | Tailwind 4, Radix/shadcn (`src/components/ui`), recharts, sonner | `package.json`, `components.json` |
| DB / "ORM" | **Supabase** (PostgreSQL + PostgREST) through `@supabase/supabase-js` 2.90 with no ORM. The browser queries tables directly under RLS; API routes use the service-role key | `src/lib/supabaseClient.ts:1-6`, `src/lib/ticket-server.ts:14-20` |
| Auth | Supabase Auth (GoTrue), email/password and recovery links. Invite-only since 2026-11-11 | `src/lib/invite.ts:80-85`, `src/app/api/auth/signup/route.ts:9-14` |
| Email | nodemailer over SMTP (host from env) | `src/lib/email.ts:6-14` |
| Scheduler | Supabase pg_cron → pg_net HTTP GET to `/api/sla/check` every 2 min | `supabase/migrations/20261112130000_sla_scheduler.sql:23-57` |
| Hosting | Vercel (comments; hard-coded `cgb-helpdesk.vercel.app` in a legacy script) | `supabase/migration_sla_cron.sql:3,20`, `supabase/migrations/README.md:28` |
| Entry points | `src/app/layout.tsx`, `src/app/(admin)/layout.tsx` (client-side shell), 39 API route handlers under `src/app/api/**/route.ts`. No `middleware.ts`/`proxy.ts` | `find src -name middleware.* -o -name proxy.*` → none |
| Build / deploy | `npm run build` / `next start` only. **No Dockerfile, compose, CI, installer or scripts dir** (the `scripts/set-sla-secrets` referenced in a migration comment does not exist) | `package.json:5-10`; search for `Dockerfile*`, `docker-compose*`, `.github`, `vercel.json`, `scripts` → none |
| Tests | **None.** No test files or test framework. Only an unused `replaceForTests` hook | search `*.test.*`, `*.spec.*`, `jest/vitest/playwright config` → none; `src/lib/askmira/core.ts:110` |
| Lint | eslint 9 + eslint-config-next | `eslint.config.mjs` |

### 2.2 Size (CONFIRMED; `wc -l` over `*.ts`/`*.tsx`, about 36.1k lines total)

| Module | Lines | Notes |
|---|---|---|
| `src/components/tickets` | 5,081 | Ticket UI (create form 1,124; table; detail panels) |
| `src/lib` (server and shared logic) | 4,989 | of which `askmira/*` 2,959 and `email.ts` 703 |
| `src/components/ui` | 4,319 | shadcn primitives |
| `src/app` (pages and API routes) | 9,103 | `assets/page.tsx` 1,348; `ticket/[id]/page.tsx` 961 |
| `src/components/user-role` / `asset` / `itsm-settings` | 1,702 / 1,559 / 1,545 | |
| **Template leftovers** (`ecommerce`, `example`, `charts`, `form`, `calendar`, `videos`, `(ui-elements)` pages, `blank`, `basic-tables`, `form-elements`) | ≈ 4,500 | Not imported by product pages (see E6) |
| SQL (legacy scripts and `supabase/migrations`) | 1,696 | |

### 2.3 Git history (CONFIRMED)

- **47 commits** from 2026-01-19 to 2026-11-12, by **1 author identity**. The remote is under an individual's personal GitHub account, not an organisation account (`git remote -v`). That is an IP/ownership question for the deal (see Open Questions).
- Commits per month: Jan 19, Feb 1, Mar 3, **Apr–Sep 0**, Oct 16, Nov 8. 24 commits fall in the last 6 months.
- Very large single-day commits with terse messages: `ef3a089` (2026-10-12, 78 files, +10,692/−5,073, "update the desing"), `90662e7` (2026-11-11, 76 files, +5,037/−3,288, "updated the tool"), `9eab4ad` (2026-11-12, 50 files, +5,878, "update the changes as per the itsm requiremnts"). This suggests little or no review (INFERRED).
- **Hotspots (files changed most, last 6 months):** `components/tickets/EngineerTicketTable.tsx` (8), `assets/page.tsx` (8), `ticket/[id]/page.tsx` (8), `lib/askmira/queries.ts` (7), `components/asset/AssetForm.tsx` (7), `lib/org.ts` (6), `lib/askmira/actions.ts` (6), `layout/AppSidebar.tsx` (6), `TicketChat.tsx` (6), `CreateTicketForm.tsx` (6), `auth/SignInForm.tsx` (6), `api/tickets/reopen/route.ts` (6).
- **TODO/FIXME/HACK/XXX:** 0 occurrences in `src`, `supabase` and the root SQL. Unfinished features are marked in UI text instead, e.g. "Attach file (coming soon)" (`TicketChat.tsx:467-473`) and "Approvals and CAB review come in a later release" (`ChangeDetails.tsx:132`).
- The working tree has an uncommitted, modified `GAP_ASSESSMENT.md` and an untracked `GAP_ASSESSMENT.docx` from an earlier review. **They were not used as evidence here.**

---

## 3. What exists (reverse-engineered)

### 3.1 Data model (CONFIRMED, from schema dump plus migrations)

Base tables were created by hand in the Supabase dashboard and have no `CREATE TABLE` in the repo (`supabase/migrations/README.md:42-49`). Their definitions below come from `backups/prod-20261112-002330-public-schema.sql:86-420`. Columns added later come from `supabase/migrations/*.sql`.

| Table | Purpose / key columns | Enums / constraints |
|---|---|---|
| `tenants` (new 11-11) | id, name, slug, status | status ∈ active, suspended (`20261111120000_tenancy_foundation.sql:26-33`) |
| `users` | id = auth.users.id, email, full_name, role, tenant_id, organization_id, HR fields (DOB, addresses, phone *numeric*, employee_id, manager…) | role ∈ user, engineer, admin, superadmin (`tenancy_foundation.sql:69-81`); dump `:395-420` |
| `organizations` | "client companies" inside a tenant (label only), name, domain, status | status ∈ active, inactive |
| `tickets` | requester_id, requester_name (denormalised), subject, description, category/sub_category (**text**, not FK), impact, urgency, priority, status, assignee, SLA timestamps and breach flags, hold fields; from 11-12 also ticket_type, number, problem fields, change fields | ticket_type ∈ incident, service_request, problem, change; priority ∈ low…critical; change_type ∈ standard, normal, emergency; risk ∈ low/medium/high (`20261112120000_itsm_core.sql:22-78`). **status has no CHECK constraint** |
| `ticket_messages` | chat lines | sender_role ∈ user, engineer |
| `ticket_attachments` | file_name, file_path (Supabase Storage bucket `ticket-attachments`), size | |
| `ticket_activity` | append-only event log (action text, details jsonb) | actions used: created, acquired, closed, hold, reopened, reassigned, updated, linked, unlinked, sla_*_breach |
| `ticket_assignments` | assignment history | action ∈ acquired, reassigned (text) |
| `ticket_links` (new) | from_ticket → to_ticket | link_type ∈ related, caused_by, duplicate_of, implements (`itsm_core.sql:230-241`) |
| `ticket_categories` (new) | two-level tree per tenant, optional ticket_types filter | `itsm_core.sql:167-181` |
| `priority_matrix` (new) | (tenant, impact, urgency) → priority | `itsm_core.sql:186-192` |
| `sla_policies` (new) | per tenant × optional type × priority: response/resolution minutes, business_hours flag | `itsm_core.sql:198-210` |
| `tenant_settings` (new) | timezone (default `Asia/Kolkata`), work days and hours, holidays `date[]` | `itsm_core.sql:215-225` |
| `tenant_counters` (new) | per-tenant, per-type numbering → INC0001001… | `itsm_core.sql:86-161` |
| `notifications` | in-app notifications (ticket_id **NOT NULL**, so ticket events only) | dump `:240-249` |
| `assets` | asset_code (unique per tenant), asset_type (**free text**), model, serial_no, status, condition, location, room, department, parent_asset_id, warranty, organization_id | status ∈ in_use, spare, retired (app-enforced, `src/lib/assets-server.ts:6`) |
| `asset_details` | key/value pairs; app whitelist = serial_no, cpu, ram, storage, os_name, mac_address, vendor | `assets-server.ts:7` |
| `asset_assignments` | asset ↔ user history; one active assignment per asset | dump unique index `one_active_assignment_per_asset` |
| `asset_tickets` | asset ↔ ticket link | |
| `asset_activity_log` | leftover table, **unused** by the app | `grep asset_activity_log src` → none |
| `user_organization_access` | retired cross-domain grants | `tenancy_foundation.sql:111-112` |
| `askmira_links`, `askmira_connect_codes`, `askmira_people`, `askmira_used_tokens` | HRMS connector state (server-only) | `supabase/migration_askmira.sql:18-63` |

ER summary: see Appendix A.

### 3.2 Ticket lifecycle (CONFIRMED)

```
new ──acquire──▶ open ──close──▶ closed ──reopen──▶ open
                  │  ▲
                  hold  resume (reopen)
                  ▼  │
                  hold   (24/48/72 h; never auto-expires)
reassign: open → open (new assignee)
```
- The statuses written by code are only `new`, `open`, `hold` and `closed` (`api/tickets/create/route.ts:156`, `acquire/route.ts:45`, `status/route.ts:63,84`, `reopen/route.ts:58,81`, `reassign/route.ts:64`). `in_progress` appears in queries and UI but is never set (`sla/check/route.ts:185`, `ticket/[id]/page.tsx:76`).
- **All four record types share this single lifecycle.** Changes have no approval, scheduling or implementation states, and there is no `resolved` / requester-confirm step (CONFIRMED).
- `hold_until` is computed (`status/route.ts:88`) but nothing ever acts on it. A ticket on hold stays paused until someone reopens it (`grep hold_until src` shows only writes and display).
- Rules (`src/lib/ticket-access.ts:48-71`): the IT team sees every ticket in its tenant. Only the **assigned** engineer can close, hold or chat. The assignee or an admin can transfer. The requester can see and chat on their own tickets. Requesters may raise only incidents and service requests (`src/lib/itsm.ts:25`).

### 3.3 Roles and permissions (CONFIRMED)

There are four fixed roles: `user`, `engineer`, `admin` (tenant), and `superadmin` (global, across all tenants) (`src/lib/ticket-server.ts:10-11`). They are enforced in API routes through `requireActor(...{roles})` (`ticket-server.ts:74-98`) and in the database through tenant-scoped RLS (`tenancy_foundation.sql:245-337`). Page protection is client-side only (`src/components/auth/RoleGate.tsx:1-55`, `src/app/(admin)/layout.tsx:1-39`). There are no permission objects, groups/teams, assignment groups, or field-level permissions.

### 3.4 Notifications and email (CONFIRMED)

- The routing table is in `src/lib/ticket-notify.ts:1-14`: created, acquired, closed/hold/reopened and transferred each produce web and/or email notifications. Chat messages notify the other party unless they are online (`api/tickets/message/route.ts:68-102`). SLA warnings at ⅔ of response time and response/resolution breaches go to tenant admins (`api/sla/check/route.ts:104-224`).
- Email templates are hard-coded HTML in `src/lib/email.ts`, branded "CGB Solutions" (`:336-337, 431, 459, 591-593`), with user text escaped (`:64-76`). There is no template editor and no per-tenant branding.
- Delivery happens inline through Next `after()` or `await` with `.catch(console.error)`. **There is no queue, no retry and no outbound log** (`create/route.ts:205-209`, `sla/check/route.ts:69-80`).
- **Inbound email: none** (search `imap|inbound|mailparser|pop3|email.?to.?ticket` → no hits).

### 3.5 External integrations (CONFIRMED)

| Integration | Mechanism | Evidence |
|---|---|---|
| Supabase cloud (DB, Auth, Storage, Realtime, pg_cron, pg_net, Vault) | SDK + SQL | throughout; `sla_scheduler.sql:23-57` |
| Vercel | hosting, `after()` | `supabase/migration_sla_cron.sql:3` |
| SMTP server | nodemailer | `src/lib/email.ts:6-14` |
| Google Fonts | `next/font/google` (downloaded at **build** time) | `src/app/layout.tsx:1,10-11` |
| **AskMira(a) HRMS** | Custom HS256 server-to-server tokens. User provisioning/sync, SSO "launch" by magic link, ticket query/act, and a platform API that **creates tenants** | `src/lib/askmira/core.ts:1-26, 200-374`, `launch.ts:31-85`, `platform.ts:1-23, 404-436` |

---

## 4. Gap matrix vs Phase 1 target

Status and Evidence are CONFIRMED unless the row says otherwise. Verdict and Effort are always INFERRED (judgement). Effort sizes: S ≤ 2 pw, M 2–5, L 5–10, XL > 10. **All numbers are estimates.**

| # | Item | Status | Evidence | Verdict | Effort (pw, est.) |
|---|---|---|---|---|---|
| A1 | Incident / SR / Problem / Change as distinct record types | **Partial** | One `tickets` table with a `ticket_type` discriminator, per-type numbering, and problem/change columns (`itsm_core.sql:22-56, 86-161`). The lifecycle is shared by all types (§3.2). Changes have no states beyond new/open/hold/closed | REFACTOR (per-type state machines, change/problem-specific tables) | M, 3–5 |
| A2 | Configurable forms, categories, priority matrix | **Partial** | Categories (2-level, per tenant) and the 3×3 matrix are configurable through admin API and UI (`api/admin/itsm/categories|matrix`, `components/itsm-settings`). **No custom fields or form designer** (search `custom_field|form_schema` → none). Ticket `category` is text, not an FK | KEEP categories and matrix; build custom fields | M, 3–5 |
| A3 | SLA/OLA engine | **Partial** | Present: per-tenant policies by type × priority, a business-hours calendar with time zone and holidays (`src/lib/itsm.ts:186-254`), pause on hold (`itsm-server.ts:153-165`), ⅔ warning, breach flags and emails (`sla/check/route.ts:104-224`). Missing: **OLA**, multi-level escalation, pause reasons, hold auto-expiry, SLA history per ticket, and a reliable scheduler (HTTP poll every 2 min, sequential N+1 loop) | KEEP clock maths (`itsm.ts`); REFACTOR engine onto a job queue | M, 3–5 |
| A4 | Workflow / approvals / CAB / maintenance windows | **Missing** | "Approvals and CAB review come in a later release" (`ChangeDetails.tsx:132`). Only `planned_start/end` on a change (`itsm_core.sql:31-32`). Search `approv|cab|maintenance.?window|blackout` → only that UI note and the AskMira "approve connection" | REWRITE (new) | L, 6–10 |
| A5 | Service catalog and request fulfilment | **Missing** | "Service Requests" is just a seeded category (`itsm_core.sql:262`). Search `catalog|request_item|fulfil` → none | New build | L, 5–8 |
| A6 | Knowledge base with ticket linking | **Missing** | Search `knowledge|kb_article|article` → none | New build | M, 3–5 |
| A7 | Email-to-ticket and templated notifications | **Partial** (outbound only) | Outbound is hard-coded, CGB-branded HTML (`email.ts:336-593`). Inbound: none (§3.4) | REFACTOR templates; build inbound | M, 4–6 |
| A8 | Reporting, dashboards, export, audit reports | **Partial (minimal)** | Dashboard has overview cards, a teammates card and a pie chart (`src/app/(admin)/page.tsx:16-35`). The only export is the asset XLSX (`assets/page.tsx:751-754`). No ticket export, report builder or audit report (search `writeFile|json_to_sheet|text/csv`) | REWRITE | L, 5–8 |
| B1 | CI model, relationships, CI types, extensibility | **Partial (asset register only)** | `assets` with free-text `asset_type`, fixed key whitelist in `asset_details` (`assets-server.ts:6-7`), and only `parent_asset_id` as a relationship (dump `:212-231`). Search `relationship|ci_type|ci_class|depends_on|cmdb` → none | REWRITE as CMDB (CI classes, attributes schema, typed relationships); migrate assets as CIs | L, 5–8 |
| B2 | Tickets/changes ↔ CIs | **Partial** | `asset_tickets` lets you link one asset at ticket creation (`create/route.ts:111-127, 177-182`). There is no UI or API to link CIs to changes or problems afterwards, and no impact analysis | REFACTOR | S, 1–2 |
| B3 | Discovery / import (CSV, API, agent) | **Partial** | Client-side XLSX/CSV parse, then one `POST /api/assets` per row (`AssetImportDialog.tsx:186-189, 241`). REST create exists (`api/assets/route.ts:26-68`). No discovery or agent | KEEP import UX; build server-side bulk import | M, 2–4 |
| C1 | Agent, inventory, device check-in | **Missing** | Search `heartbeat|check.?in|endpoint.?agent|device_id|hostname` → only the UI presence "heartbeat" (`TeammatesCard.tsx:47`) and asset import columns | New build (agent, enrolment, mTLS identity, inventory) | XL, 12–20 |
| C2 | Patch scan/deploy/compliance, job queue, maintenance windows | **Missing** | Search `patch(es|_job|_scan|ing)|wsus|winget|compliance|maintenance.?window` → none. "Update / Patch Issue" is only a category name | New build (scan, approval rings, deploy jobs, offline patch repository for air-gap, compliance reports) | XL, 16–26 |
| C3 | Remote shell / desktop | **Missing** | Search `websocket|pty|remote.?(shell|desktop)|rdp|vnc|webrtc` → none (the "pty" hits are words like "empty") | New build (shell first; desktop is a separate XL) | L, 6–12 (shell + basic desktop relay) |
| C4 | Where an agent gateway would plug in | **Missing** | There is **no long-running server process**: everything is Next.js route handlers on serverless (`export const runtime = "nodejs"` per route). The only scheduler is pg_cron → HTTP. Nothing can hold persistent agent connections (INFERRED from architecture) | New service (separate gateway process plus Postgres job tables). Candidate hosts: a new Node/Go service beside Next; the ticket and asset APIs become its consumers | M, 3–5 (design + skeleton; build is in C1–C3) |
| D1 | Multi-tenancy / tenant config | **Present (new) — hardcoding in seed** | `tenants` + `tenant_id NOT NULL` everywhere + tenant RLS (`tenancy_foundation.sql:26-61, 245-337`). The default tenant "CGB Solutions" is seeded by name (`:35-37`). Super admin is global (`ticket-server.ts:100-104`). Default TZ `Asia/Kolkata` (`itsm_core.sql:217`, `itsm-server.ts:42`) | KEEP model, REFACTOR seeds and branding | S, 1–2 |
| D2 | AuthN/AuthZ: local, LDAP/AD, SAML/OIDC, MFA, RBAC | **Partial** | Local email/password via Supabase Auth; invite-only (`invite.ts`). **No LDAP/SAML/OIDC/MFA** (search `ldap|saml|oidc|openid|entra|keycloak|mfa|totp|2fa|aal2` → none). RBAC is 4 fixed roles (§3.3) | REWRITE (pluggable IdP + MFA + permission model) | L, 5–8 |
| D3 | Audit trail | **Partial** | `ticket_activity` captures ticket changes with from/to values (`api/tickets/[id]/route.ts:158-171`); browsers cannot write it (`tenancy_foundation.sql:204-205`). **Not immutable** to the service role (no append-only trigger or hash chain). **No audit** of role changes, SLA/category/matrix changes, asset edits or deletes, logins (`asset_activity_log` unused) | REFACTOR into a generic append-only audit log | M, 2–4 |
| D4 | Cloud / internet dependencies | **Present (blocking)** | Supabase cloud services (§3.5), Vercel `after()`, pg_net calling a public URL (`sla_scheduler.sql:23-45`), Google Fonts at build (`layout.tsx:1`), SMTP. Browser data access via PostgREST in pages and components (e.g. `EngineerTicketTable.tsx:106-117`, `hooks/useCurrentUser.ts:44`) | REWRITE data-access layer (or self-host the full Supabase stack; see §6.3) | L, 6–10 |
| D5 | Packaging, config mgmt, upgrade/migration path, backup/restore | **Missing** | No Dockerfile, compose or installer (§2.1). Migrations are partly ad hoc (E5). Backups are manual `pg_dump` files in the working copy (`backups/`, gitignored at `.gitignore:40`) | New build | L, 4–6 |
| D6 | Offline / air-gapped behaviour, offline licensing | **Missing** | No licensing code (search `license|licence|activation` → only a category name and auth layout text). Runtime needs Supabase cloud; build needs Google Fonts | New build | M, 3–5 |
| D7 | Background job / queue mechanism and reliability | **Partial (weak)** | pg_cron → HTTP every 2 min (`sla_scheduler.sql:57`). Email and notifications are fire-and-forget through `after()` (`create/route.ts:205-209`). No retries, dead-letter or idempotency keys (except claim-flags in the SLA check, `sla/check/route.ts:120-127`) | REWRITE (Postgres-backed queue such as pg-boss or similar, in-process worker) | M, 2–4 |
| D8 | HA / scalability limits | **Partial (INFERRED)** | The app is stateless. State is in Postgres, sessions are Supabase JWTs, presence uses Supabase Realtime, and files are in Supabase Storage. Uploads are buffered fully in memory, up to 5×10 MB per request (`create/route.ts:12-13, 184-186`). The SLA loop and `loadTicketStaffPicker` load **all** staff of **all** tenants on every call (`src/lib/org.ts:49-60`) | REFACTOR (streaming uploads, scoped queries, worker scaling) | M, 2–3 |
| E1 | Security review | See §5 | Critical historical exposure; current server code mostly sound | REFACTOR | M, 2–4 |
| E2 | Dependency audit and licences | See §5 | 23 advisories; 2 licence flags in dead code; 3 unused deps (`swiper`, `@supabase/auth-helpers-*`, `react-dnd`) | REFACTOR (upgrade/remove) | S, 1–2 |
| E3 | Test coverage | **Missing** | No tests at all (§2.1) | New (unit tests for SLA clock and permissions first, then API integration tests) | L, 4–8 |
| E4 | Logging, error handling, observability | **Partial (weak)** | 68 `console.error`, 22 `console.log`, 2 `console.warn`; no logger, tracing, metrics or health endpoint (`ls src/app/api`). Errors are caught per route, returning generic 500s (good). PII (emails) is logged (`askmira/launch.ts:83`, `actions.ts:157`, `connect.ts:286`) | REWRITE (structured logging, health/readiness, support bundle) | M, 2–3 |
| E5 | Schema migrations | **Partial / ad hoc** | 9 legacy scripts "run by hand in the SQL editor" plus 3 managed files (`supabase/migrations/README.md:8-28`). **No baseline for the base tables** (`README.md:42-49`). There is no tool that records which migrations were applied, and no down-migrations (only a commented "To undo" in one file). The README's "assumed applied" list is **contradicted by the prod snapshot** (§5, S2) | REWRITE (baseline + migration tool with history table) | S, 1–2 |
| E6 | Code health | **Partial** | Large client "god-pages" (`assets/page.tsx` 1,348; `CreateTicketForm.tsx` 1,124; `UserRoleTable.tsx` 1,004; `ticket/[id]/page.tsx` 961) mix data access and UI. About 4.5k lines of unused template code. Dead `src/lib/ticket-categories.ts` (`CATEGORY_MAP` has no importers) duplicates the DB seed. Attachments are saved but **never shown** (`ticket/[id]/page.tsx:818` passes `attachments={[]}`). Notification text uses the old id stub instead of the ticket number (`api/tickets/message/route.ts:76`). Positives: the newer server code (`src/lib/*-server.ts`, `api/tickets/*`) is consistent, validated, tenant-checked and uses optimistic concurrency (`api/tickets/[id]/route.ts:149-154`, `acquire/route.ts:41-55`) | REFACTOR | M, 2–3 |

**Totals (estimates):** A 32–52 · B 8–14 · C 37–63 · D 25–42 · E 12–22 → **about 114–193 pw** to Phase 1 under the recommended path.

---

## 5. Security and licence findings

No secret values appear in this report. `.env` holds 14 keys (Supabase URL, anon and service-role keys, **a direct production DB URL `PROD_DB_URL`**, SMTP credentials, cron and AskMira secrets). It is gitignored (`.gitignore:13`), and a scan of all commits found no JWT-shaped tokens, `postgres://user:pass@` URLs or literal bearer secrets (CONFIRMED; commands in Appendix B).

### 5.1 Security

| # | Sev. | Finding | Evidence | Fix | Basis |
|---|---|---|---|---|---|
| S1 | **Critical** | **Production DB was open to the internet until at least 2026-11-12 00:23.** RLS was not enabled on `tickets`, `users`, `assets`, `ticket_messages`, `ticket_attachments`, `notifications` or the asset tables, and `anon` and `authenticated` held `GRANT ALL`. The anon key is public by design (shipped to every browser) | `backups/prod-20261112-002330-public-schema.sql:923-953` (RLS enabled only on askmira_* and ticket_activity/assignments), `:1064, 1073, 1118, 1127, 1145` (GRANT ALL … TO anon); the only users policies were inert because RLS was off (`:959-966`) | 1) Verify **now** in production: `pg_policies`, `relrowsecurity` and table grants. 2) Pull Supabase API logs for anon-key traffic on these tables. 3) Treat data integrity and confidentiality for Jan–Nov 2026 as unverified, and run an incident / DPDP breach assessment | CONFIRMED for the snapshot; current state INFERRED-fixed by `tenancy_foundation.sql:180-238` (README claims applied 2026-11-12, `supabase/migrations/README.md:26`) |
| S2 | High | **Schema drift / false migration record.** The README lists legacy scripts as "assumed applied". The snapshot shows no `org_domain` (multitenant script), no `is_verified` (email-verification script), table grants not revoked (`ticket_messages_server_only`), and a plain `UNIQUE(asset_code)` instead of the `upper(trim())` index | `supabase/migrations/README.md:8-20`; dump `:323-339, 395-420, 499, 1118` | Baseline the real prod schema, adopt a migration tool with an applied-history table, and diff prod against the repo before every release | CONFIRMED |
| S3 | High | `next@16.0.10` has advisories including RSC deserialization DoS and image-optimizer DoS; audit marks it critical, fix in `next@16.4.6` | `npm audit` output (Appendix B); `package.json` | Upgrade Next (and eslint-config-next) | CONFIRMED (audit) |
| S4 | High | `nodemailer@8.0.3`: SMTP command / CRLF injection advisories | `npm audit`; used in `src/lib/email.ts` | Upgrade (audit fix → 10.6.1) | CONFIRMED (audit) |
| S5 | High | `xlsx@0.18.5` (SheetJS): prototype pollution and ReDoS, **no npm fix** (the npm package is abandoned upstream). It parses user-supplied files in the browser | `AssetImportDialog.tsx:4, 186-189`; `npm audit` | Replace with a maintained parser (e.g. exceljs) or the vendored SheetJS ≥ 0.20.2; parse server-side with size limits | CONFIRMED (audit); impact limited to the uploader's browser (INFERRED) |
| S6 | Medium | AskMira HMAC derivation key **falls back to the Supabase service-role key** when `ASKMIRA_LINK_SECRET` is unset, which is key reuse | `src/lib/askmira/core.ts:200-214` | Require a dedicated secret; refuse to start otherwise | CONFIRMED |
| S7 | Medium | AskMira (an external system) can grant the helpdesk **admin** role to people it sends | `src/lib/askmira/people.ts:47, 75, 100, 204-221` | Map external roles to "user" only, or require local admin approval for elevation | CONFIRMED |
| S8 | Medium | **No rate limiting** anywhere. Unauthenticated endpoints: `auth/resend-verification` (also reveals whether an account exists through `already_verified`), `integrations/askmira/launch`, `connect/token` | search `rate.?limit` → none; `api/auth/resend-verification/route.ts:50-57` | Add rate limiting (per IP and account) and uniform responses | CONFIRMED |
| S9 | Medium | No security headers or CSP (`next.config.ts` has none). The supabase-js browser client keeps session tokens in localStorage by default, so any XSS means token theft | `next.config.ts:1-24`; `src/lib/supabaseClient.ts:6` | Add CSP/HSTS/frame-ancestors; move to httpOnly cookie sessions in the new auth layer | CONFIRMED (headers); INFERRED (storage default) |
| S10 | Medium | Sensitive data on developer disk: production `pg_dump` files with user PII and `.env` with the prod DB URL and service-role key, unencrypted in the working copy | `backups/*.dump` (gitignored `.gitignore:40`), `.env` | Move to an encrypted vault; rotate the service-role key and DB password after the transaction | CONFIRMED (presence); contents not opened |
| S11 | Medium | PII in application logs (emails) and HR PII stored in `users` (DOB, addresses) with no retention or masking policy; relevant to India's DPDP Act | `askmira/launch.ts:83`, `actions.ts:157`; dump `:405-406` | Log IDs not emails; define retention; restrict HR fields | CONFIRMED (code); legal impact INFERRED |
| S12 | Low | Before 11-11, `ticket_activity` and `ticket_assignments` were readable by any signed-in user across organisations (`USING (true)`) | `supabase/migration_sla_activity.sql:56-59, 69-72`; dump `:888, 895` | Fixed by `tenancy_foundation.sql:285-291` (verify in prod) | CONFIRMED (history) |
| S13 | Low | Attachment validation trusts the client-declared MIME type, with no AV scan. Attachments are also never retrievable in the UI, so the feature is broken | `api/tickets/create/route.ts:130-135`; `ticket/[id]/page.tsx:818` | Magic-byte sniffing, AV hook, signed download route | CONFIRMED |
| S14 | Low | RBAC granularity: engineers can bulk-delete assets | `api/assets/bulk-delete/route.ts:14` | Restrict to admins and audit-log the deletes | CONFIRMED |
| — | OK | **Injection:** no raw SQL from the app. PostgREST `.or()` filter strings are sanitised (`EngineerTicketTable.tsx:114-116`, `askmira/core.ts:154-160`, `platform.ts:155-162`) | as cited | — | CONFIRMED |
| — | OK | **IDOR / access control (current code):** every API route authenticates (`requireActor`, AskMira assertions or the cron secret) and checks the tenant and ticket role before acting (`ticket-server.ts:74-128`; per-route table in Appendix B) | as cited | Keep the pattern | CONFIRMED |
| — | OK | **CSRF:** the API uses an `Authorization: Bearer` header, not cookies (`src/lib/api-client.ts:26-33`) | — | Re-check if moving to cookies | CONFIRMED |
| — | OK | **XSS:** React escaping; email HTML escapes user text (`email.ts:64-76`). The single `dangerouslySetInnerHTML` is the shadcn chart style block (`components/ui/chart.tsx:83`) | — | — | CONFIRMED |
| — | OK | **Passwords:** none stored by the app (delegated to Supabase Auth). The cron secret uses a timing-safe compare (`sla/check/route.ts:44-49`). AskMira tokens use HS256 only, timing-safe, body-hash bound, single-use `jti` (`core.ts:237-259, 338-374`) | — | — | CONFIRMED (code); GoTrue bcrypt INFERRED |

### 5.2 Licences (CONFIRMED from `node_modules/*/package.json` and LICENSE files; about 720 packages scanned)

| Sev. | Package | Licence | Evidence / usage | Fix |
|---|---|---|---|---|
| **High (legal)** | `@react-jvectormap/lib@1.0.3` | `package.json` declares **"(AGPL OR Commercial)"**; the bundled LICENSE file is MIT text, so the two conflict | Only used by template `src/components/ecommerce/CountryMap.tsx`, which **no page imports** | Delete the template code and the `@react-jvectormap/*` deps |
| **High (legal)** | `react-apexcharts@1.9.0` | "SEE LICENSE IN LICENSE": **dual licence. The free tier is limited to orgs under USD 2M revenue, and OEM/redistribution requires a paid licence** | Only template charts (`components/charts/*`, `components/ecommerce/*`), **not imported by any page** | Delete; recharts (MIT) is already used |
| Low | `@img/sharp-*` (via next) | Apache-2.0 AND LGPL-3.0-or-later (libvips binary) | Next image optimisation | Acceptable when dynamically linked; include notices |
| Low | `lightningcss`, `axe-core` (dev) | MPL-2.0 | build/dev | OK unmodified |
| Info | `caniuse-lite` | CC-BY-4.0 | build data | Attribution |
| Info | TailAdmin template | MIT (`LICENSE:1-3`) | The repo's only LICENSE is TailAdmin's; the product has no licence of its own | Add product licence and third-party notices |
| — | No GPL, SSPL or BSL found | — | scan output in Appendix B | — |

Unused direct dependencies: `swiper` (critical prototype-pollution advisory), `react-dnd`, `@supabase/auth-helpers-nextjs`/`-react` (deprecated). `grep` finds no import in `src` for any of them.

---

## 6. Recommendation and risks

### 6.1 Recommendation: (c) Hybrid, keeping the domain and rewriting the platform

This follows from the matrix: of 29 rows, **only 1 (D1, tenancy) is Present**, and even that has hard-coded seeds. 10 are Missing (all of C, plus A4–A6, D5, D6, E3), and the Partial rows that matter most (D2, D4, D7, E5) need platform-level rework. Building on the current codebase (option a) would keep a Supabase-cloud/Vercel architecture that does not ship on-prem, which conflicts with D4–D6. A pure rewrite (option b) would throw away roughly 7–12 pw of sound domain work and the client's configured data. So:

**KEEP (port with light changes)**
- `src/lib/itsm.ts`: record-type vocabulary, priority matrix, SLA business-hours clock (pure TypeScript, no I/O).
- `src/lib/itsm-server.ts`: policy selection, deadlines, hold resume. Port the data access.
- `src/lib/ticket-access.ts`: ticket permission rules.
- `src/lib/ticket-notify.ts`: notification routing table (logic only). `src/lib/email.ts` templates, after de-branding.
- `src/lib/assets-server.ts` validation and the `AssetImportDialog` import flow (swap the parser).
- **Schema concepts** from `supabase/migrations/20261111120000_tenancy_foundation.sql` (tenants, `tenant_id`) and `20261112120000_itsm_core.sql` (types, counters, categories, matrix, sla_policies, tenant_settings, ticket_links), as the seed of the new schema.
- `src/components/ui/*` (shadcn) and `src/components/itsm-settings/*` as the UI starting point.
- **All 6 months of data** (see 6.4).

**REFACTOR**
- `src/app/api/tickets/*`, `src/app/api/admin/itsm/*`, `src/app/api/assets/*`, `src/app/api/users/*`: good validation and tenant checks. Move them behind a service layer that is not tied to the Supabase client.

**REWRITE / REPLACE**
- All browser-side table access (pages and components calling `supabase.from(...)`) → server API.
- Supabase Auth → pluggable local + LDAP/AD + SAML/OIDC + MFA.
- pg_cron/pg_net/`after()` → Postgres-backed job queue with an in-process worker.
- Supabase Storage → storage abstraction (local disk / S3-compatible such as MinIO).
- Supabase Realtime → own WebSocket/SSE.
- Asset register → CMDB.
- Ticket lifecycle → per-type workflow engine with approvals.

**DROP**
- TailAdmin demo pages and components (`(ui-elements)`, `ecommerce`, `example`, `charts`, `calendar`, `videos`, `blank`, `basic-tables`, `form-elements`).
- `src/lib/ticket-categories.ts`, unused dependencies, and the legacy root SQL scripts (after baselining).
- Make **AskMira** an optional connector module, keeping it only if the client requires it.

**BUILD NEW:** A4–A8, B1, C1–C4, D2, D5, D6, E3.

### 6.2 Effort delta to Phase 1 by section (person-weeks; **estimates**, INFERRED)

| Section | Recommended hybrid (from current code) | Greenfield equivalent | Saved by existing code |
|---|---|---|---|
| A. ITSM core | 32–52 | 36–59 | 4–7 |
| B. CMDB | 8–14 | 9–16 | 1–2 |
| C. Agent and patching | 37–63 | 37–63 | 0 |
| D. Platform and on-prem | 25–42 | 27–45 | 2–3 |
| **A–D total** | **102–171** | **109–183** | **7–12** |
| E. Quality (tests, deps, cleanup) | 12–22 | (tests still needed) | — |

### 6.3 Alternative considered: build in place on self-hosted Supabase

If self-hosted Supabase (about 10 containers: Postgres, GoTrue, PostgREST, Realtime, Storage, Kong, Studio and others) is acceptable as the on-prem runtime, option (a) becomes technically viable. It saves roughly **4–7 pw of D4**, but at a cost:
- Every customer gets that whole stack to install and upgrade.
- GoTrue has no LDAP.
- RLS stays the primary API security boundary, and that boundary already failed once (S1).

This alternative is not recommended (INFERRED).

### 6.4 Top 10 risks (ranked by severity)

1. **Unverified data exposure (S1).** Possible unauthorised read/write of all tickets, users and assets for about 10 months. Legal and DPDP exposure, and the integrity of the migrated history cannot be guaranteed.
2. **The agent/patching scope is 100% greenfield** and is the largest workstream (37–63 pw). The current architecture has no process that can host agent connections.
3. **Platform lock-in** to Supabase cloud and Vercel throughout the UI (D4), which blocks on-prem and air-gap delivery.
4. **Bus factor of 1 and no tests.** A single author makes 5–10k-line commits with no review trail. Regressions are likely during migration.
5. **Unreproducible schema / drift (S2, E5).** Base tables exist only in prod, and the README misstates what was applied.
6. **Vulnerable dependencies** (S3–S5), including an unmaintained `xlsx` and critical advisories on `next`.
7. **No enterprise identity** (D2: LDAP/AD/SAML/MFA), a common hard requirement for on-prem buyers.
8. **Licence contamination** if the template code ships (jvectormap AGPL/commercial, ApexCharts OEM). It is easy to remove but must be removed.
9. **Unreliable background processing** (D7). Lost emails, SLA polling over public HTTP, and holds that never expire (an SLA can be paused indefinitely).
10. **IP and ownership.** The repo sits under a personal account, the product is a template fork, and the README and package name are still the template's. Ownership of code and of the AskMira integration needs to be settled in the deal.

### 6.5 Data migration note (what to carry from the 6-month dataset)

| Carry over (CONFIRMED tables) | Caveats (INFERRED unless cited) |
|---|---|
| `tickets` (+ number, type, category, priority, status, timestamps) | SLA deadlines before 2026-11-12 come from the fixed 15 min / 6 h rule (`migration_sla_activity.sql:19-26`). Treat them as historical, not recomputable. Impact and urgency are **empty in production** (`itsm_core.sql:58`). Categories are free text: map them to the new taxonomy. `requester_name` is denormalised. All rows were backfilled to tenant "CGB Solutions" (`tenancy_foundation.sql:35-61`). `in_progress` was never used |
| `ticket_messages`, `ticket_activity`, `ticket_assignments`, `ticket_links` | Activity is a usable audit history, but see S1: integrity before 11-12 cannot be guaranteed |
| `ticket_attachments` **plus the objects in Supabase Storage bucket `ticket-attachments`** | Files must be exported separately. Users never saw them in the UI |
| `assets`, `asset_details`, `asset_assignments`, `asset_tickets` | Load as CIs. `asset_type` is free text, so normalise it into CI classes. `asset_activity_log` is unused, so skip it |
| `users`, `organizations`, `tenants` | Migrate identity (email, name, role, department). Password hashes live in `auth.users` (bcrypt). Carry them only if the new auth accepts bcrypt import; otherwise force a reset. Drop the legacy verification fields. `user_organization_access` is retired |
| `ticket_categories`, `priority_matrix`, `sla_policies`, `tenant_settings` | Carry as-is (if the itsm_core migration was applied in prod; see Open Questions) |
| `notifications` | Drop (transient) |
| `askmira_*` | Carry only if the connector is kept; the derived secrets depend on the server key (`core.ts:209-214`) |

### 6.6 Five questions to ask the client's team before committing

1. **Security incident:** "Can you confirm the current RLS policies and grants in production, and have you checked Supabase logs for anonymous-key access to tickets and users before 12 Nov 2026? Who is your DPO for a DPDP assessment?"
2. **Real usage:** "How many requesters, engineers and admins are active, how many tickets per month, and which screens do agents use daily? Are problems, changes, SLA policies and business hours actually in use yet, or only incidents?"
3. **Identity and integration:** "What is your identity source (AD, Entra, Google) and is MFA mandatory? Is the AskMira HRMS link business-critical? Which mailbox should become email-to-ticket?"
4. **Endpoint estate:** "How many endpoints, which OS mix, which patching tool is in use today, how many sites are air-gapped or offline, and what maintenance-window and change-approval process do you follow outside this tool?"
5. **Ownership and operations:** "Who owns the code, the Supabase/Vercel accounts and the GitHub repository? What are the current backup, retention and restore arrangements? What migration downtime and data-retention period would you accept?"

---

## 7. Open questions

1. **Current production state.** Has `20261111120000_tenancy_foundation.sql` actually been applied (README says so, `supabase/migrations/README.md:26`)? Are `20261112120000_itsm_core.sql` and `20261112130000_sla_scheduler.sql` applied? The README does not say, and a dump named `backups/prod-before-itsm-20261112-064712.dump` suggests the ITSM core was being applied on 2026-11-12. The `.dump` files were not opened (they contain PII, and `pg_restore` is not installed).
2. **Supabase settings not in the repo:** Storage bucket policies for `ticket-attachments`, Auth settings (self sign-up and Google provider disabled as instructed at `tenancy_foundation.sql:400-401`?), password policy, PITR/backup plan, and project plan tier.
3. **Data volumes and usage:** row counts, ticket distribution by type, status and category, and active users. These are not derivable without the data, so all Step 4 usage claims below are from code only.
4. **Which deployment is live.** Is the app in production the HEAD (`3e2b09f`) or an older commit? Are the template demo pages reachable in production?
5. **Who the "client" is.** The only seeded tenant is "CGB Solutions" (`tenancy_foundation.sql:35-37`). Client domains appear in legacy comments (`supabase-superadmin-migration.sql:133-134`). Are there several client companies inside one tenant today?
6. **Vercel request limits.** Do 10 MB attachments (`create/route.ts:13`) actually succeed on the hosting plan? INFERRED risk: serverless body-size limits are smaller.
7. **The earlier `GAP_ASSESSMENT.md/.docx` in the repo.** Who produced it, and were any of its recommendations already acted on?

### Step 4: live-usage signals (from code and schema only; usage is INFERRED)

- **Most-used modules (by churn):** ticket list and detail, asset register, AskMira connector (§2.3 hotspots).
- **Custom data:** HR-style profile fields on `users` (DOB, addresses, employee_id, manager; dump `:395-420`) suggest HRMS-driven use. The fixed asset detail keys (cpu, ram, storage, os_name, mac_address) suggest laptop/desktop inventory.
- **Hard-coded client logic that would break a multi-client product (CONFIRMED):**
  - "CGB Solutions" branding in all emails (`email.ts:336-337, 431, 459, 591-593`) and page titles (`src/app/(admin)/page.tsx:12-13`, plus about 30 page metadata strings).
  - `Asia/Kolkata` defaults (`itsm_core.sql:217`, `itsm-server.ts:42`).
  - Seeded tenant name (`tenancy_foundation.sql:35-37`).
  - A legacy script with the client's Vercel URL (`migration_sla_cron.sql:20`).
  - Asset code examples "CGB-001" (`AssetForm.tsx:61`, `AssetImportDialog.tsx:155`).
  - The AskMira connector, a first-party HRMS integration built into the core (`src/lib/askmira/*`, 2,959 lines).
- **One-off hacks:** pg_cron workaround for the Vercel Hobby cron limit (`migration_sla_cron.sql:3-4`); fixed SLA backfill (`migration_sla_activity.sql:19-26`); "email domain = organisation" access model, now retired (`supabase-multitenant-migration.sql:26-30`).

---

## Appendix A: ER summary

```
tenants 1─┬─< users >─┐ (organization_id)        tenants 1─< ticket_categories (self-ref parent_id)
          ├─< organizations ──────────────┘      tenants 1─< priority_matrix
          ├─< tickets ──────────────┐            tenants 1─< sla_policies
          │     │ requester_id → auth.users       tenants 1─1 tenant_settings
          │     │ assignee     → auth.users       tenants 1─< tenant_counters
          │     ├─< ticket_messages (sender_id → auth.users)
          │     ├─< ticket_attachments (file_path → Storage bucket)
          │     ├─< ticket_activity (actor_id → auth.users)
          │     ├─< ticket_assignments (engineer_id → auth.users)
          │     ├─< notifications (user_id, actor_id)
          │     ├─< ticket_links >── tickets  (related | caused_by | duplicate_of | implements)
          │     └─< asset_tickets >── assets
          └─< assets (parent_asset_id → assets; organization_id → organizations)
                ├─< asset_details (key/value)
                └─< asset_assignments (user_id → users; one open per asset)
organizations 1─1 askmira_links ; organizations 1─< askmira_people >─ users ; askmira_connect_codes ; askmira_used_tokens
users ─< user_organization_access >─ organizations   (retired)
```
Sources: dump `:86-420, 423-881` (constraints and FKs), `tenancy_foundation.sql:26-61, 98-100`, `itsm_core.sql:86-241`.

## Appendix B: Commands and searches used (all read-only)

- Structure: `ls -la`, `find . -maxdepth 3` (excluding node_modules/.git/.next), `Get-ChildItem -Force`.
- Git: `git log --oneline | wc -l`; `git shortlog -sne --all` (emails redacted); `git log --format=%ad --date=format:%Y-%m | uniq -c`; `git log --since=2026-05-26 --name-only | sort | uniq -c | sort -rn` (hotspots); `git log --shortstat`; `git status --short`; `git remote -v` (credentials masked).
- Secrets: `.env` key names only (`sed 's/=.*$/=<redacted>/'`); `git ls-files .env`; history scans for `eyJ…\.…` JWTs, `postgres://…:…@`, `Bearer [A-Za-z0-9]{16,}` (counts only; all 0).
- LOC: `find … -name '*.ts*' -exec cat {} + | wc -l` per directory; `wc -l` per file.
- Schema: `grep -c '^(COPY|INSERT INTO)'` on `backups/prod-20261112-002330-public-schema.sql` (0, so schema-only) and then read; `grep -n 'ENABLE ROW LEVEL SECURITY|CREATE POLICY|GRANT ALL … TO anon'`. The `.dump` files were **not** opened.
- Gap searches (ripgrep over `src`, `*.ts`/`*.tsx`, template dirs excluded): `knowledge|kb_article|article`; `catalog|catalogue|request_item|fulfil`; `approv|\bcab\b|change_advisory`; `maintenance.?window|blackout|freeze`; `imap|inbound|mailparser|pop3|email.?to.?ticket|webhook`; `relationship|ci_type|ci_class|depends_on|cmdb`; `heartbeat|check.?in|endpoint.?agent|\bagent_|device_id|hostname`; `patch(es|_job|_scan|ing)|wsus|winget|apt-get|compliance`; `websocket|pty|remote.?(shell|desktop)|\brdp\b|\bvnc\b|webrtc`; `ldap|active.?directory|saml|oidc|openid|azure.?ad|entra|keycloak`; `\bmfa\b|totp|two.?factor|2fa|aal2|factors`; `license|licence|activation`; `writeFile|json_to_sheet|new Blob|text/csv`; `audit`; `queue|bullmq|pg-boss|graphile|retry`; `rate.?limit`; `createSignedUrl|getPublicUrl|storage`; `hold_until`; `TODO|FIXME|HACK|XXX`; `console\.(log|error|warn|info)`; `sentry|pino|winston|opentelemetry`.
- Security patterns: `dangerouslySetInnerHTML|eval\(|new Function|\.or\(|\.rpc\(|ilike|innerHTML`; browser writes `supabase.from(...).(insert|update|upsert|delete)`; per-route grep for `requireActor|assertion|claimsOf|CRON_SECRET` and for tenant checks (all 39 routes authenticate).
- Hosts: `grep -rhoE 'https?://[a-zA-Z0-9.-]+' src supabase *.sql`; `next/font|googleapis|cdn`.
- Dependencies: `npm audit --package-lock-only --json` (2 critical, 17 high, 3 moderate, 1 low); licence scan via a Node script reading every `node_modules/**/package.json` `license` field, plus `head` of flagged LICENSE files; usage check `grep -rln "swiper|auth-helpers|react-dnd|apexcharts|jvectormap" src`.
- Tests and packaging: `find` for `*.test.*`, `*.spec.*`, `jest/vitest/playwright` configs, `Dockerfile*`, `docker-compose*`, `.github`, `vercel.json`, `scripts`: none found.
- Tools **not** available or not used: `pg_restore`/`psql` (not installed; not installed by this review).
