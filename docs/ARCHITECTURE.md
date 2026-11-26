# Architecture

## Overview

```
 Browsers ──HTTPS──┐                         ┌── PostgreSQL 17 (all state, job queue, audit log)
                   ├─> Reverse proxy (TLS) ─> App (Next.js 16, Node 24) ─┤
 Endpoint agents ──┘     optional Caddy        │  - web UI (server-rendered)  └── Local disk /data/files
 (PowerShell / Python,                         │  - REST API /api/v1             (attachments, KB images,
  outbound HTTPS only)                         │  - agent API /api/agent/v1      offline patch packages)
                                               │  - worker (jobs, schedules)
 SMTP / IMAP server <──────────────────────────┤
 LDAP / AD, OIDC IdP <─────────────────────────┤
 ClamAV (optional) <───────────────────────────┘
```

One container image runs everything: the UI, both APIs and the background worker. Several replicas
can run against the same database; the queue and schedules are replica-safe. There is no
cloud dependency. Fonts are system fonts, nothing is fetched at build or run time, and the licence
is verified offline.

## Key decisions (and the gap-assessment findings they answer)

| Finding | Decision |
|---|---|
| D4: browser queried the DB through PostgREST; RLS was the security boundary and was off in production (S1) | **The browser never talks to the database.** All reads and writes go through server code (`src/lib/**`) that filters every query by `tenant_id` and checks permissions. The database is not exposed. |
| D2: Supabase Auth only, no LDAP/SAML/MFA | Own auth: local accounts (bcrypt, lockout, rate limits), **LDAP/AD** (bind + group → role mapping), **OIDC** SSO (PKCE), **TOTP MFA** with recovery codes, tenant-enforced MFA. httpOnly cookie sessions; only the SHA-256 is stored. |
| D2: 4 fixed roles | Permission-based RBAC (`src/lib/auth/permissions.ts`): 4 system roles plus tenant **custom roles**, assignment **groups**, CAB / approver groups. |
| D7: pg_cron → HTTP, fire-and-forget email | **Postgres job queue** (`jobs`, `FOR UPDATE SKIP LOCKED`, retries with back-off, dead letter, dedupe keys) and an in-process worker. Email is written to an outbox in the same transaction as the change that caused it. |
| A1: one lifecycle for all record types | **Per-type workflows** (`src/lib/itsm/workflow.ts`): incident, service request (with approval), problem (known error, root cause), change (draft → assessment → CAB → scheduled → implementing → review → closed). |
| A3: SLA engine partial, holds never expire | SLA **and OLA** clocks per ticket (`ticket_sla`), pause/resume on hold and approval, re-prioritisation, warnings at N %, breach escalation to group manager and admins, **holds end automatically**, auto-close of resolved tickets. The business-hours clock maths was ported from the old code. |
| A4: no approvals / CAB / windows | Multi-step approvals (any/all), CAB for changes, segregation of duties (nobody approves their own change), maintenance windows and **change freezes** enforced at submit and implement. |
| A5, A6 | Service catalog (form builder, manager + group approvals, fulfilment group, task templates); knowledge base (versions, review/publish, safe Markdown, ticket links, votes). |
| A7: outbound email only, hard-coded branding | Per-tenant editable templates, branding, SMTP; **email-to-ticket** over IMAP (replies thread on `[INC…]`, loop protection). |
| A8 | Dashboard, reports (volumes, SLA compliance, MTTR, backlog ageing, workload, change success), CSV exports. |
| B1–B3: asset register only | **CMDB**: CI classes with attribute schemas, typed relationships, impact analysis, assignments, history, CSV import (old asset-import columns accepted), auto-discovery from agents. |
| C1–C4: no agent, no patching, nowhere to host agents | **Agent API in the app** (outbound polling, long-poll jobs), Windows (PowerShell, Windows Update API) and Linux/macOS (Python, apt/dnf/yum/zypper) agents, inventory, patch catalog, approval, deployment rings, policies, maintenance windows, offline package repository for air-gapped sites, compliance reporting, and remote scripts (admin-only, audited). |
| D3: audit not immutable | `audit_log` is **append-only** (triggers refuse UPDATE/DELETE/TRUNCATE) and **hash-chained**; verify with `npm run audit:verify` or in the UI. |
| D5: no packaging or migrations | Dockerfile + compose, **migration runner** with an applied-history table and checksums (runs at start, under an advisory lock), backup and restore scripts, `/api/health` and `/api/ready`. |
| D6: no offline licensing | Ed25519-signed licence file verified offline. Evaluation mode allows 25 devices. Expiry never locks out the service desk. |
| D1: hard-coded tenant/branding | Multi-tenant (`tenant_id` everywhere) with per-tenant branding, calendar and settings. No customer names in code. |
| E4: console logging, PII in logs | Structured JSON logs (ids, not emails), health/readiness endpoints. |
| S13: client MIME trusted, attachments broken | Content-type sniffed from bytes, executables refused, optional ClamAV, downloads only through an access-checked route, served as attachments with `nosniff` and a sandbox CSP. |
| S3–S5, licences | Current `next`, `nodemailer`. No `xlsx` (a CSV parser of our own), no template code, no AGPL or revenue-gated packages. |
| S8, S9 | DB-backed rate limits (sign-in, reset, MFA, enrolment, API), CSP, HSTS (behind HTTPS), frame-ancestors none, CSRF origin checks on cookie-authenticated API writes; server actions check origin natively. |
| E3: no tests | Vitest unit tests (clock, workflow, access rules, TOTP, sniffing, email, …) and integration tests against real PostgreSQL. |

## Code map

| Path | What |
|---|---|
| `db/migrations/` | Schema (0001 platform, 0002 ITSM, 0003 CMDB, 0004 endpoints, …) |
| `src/lib/db/` | Pool, query helpers, migration runner |
| `src/lib/auth/` | Sessions, password and LDAP sign-in, OIDC, TOTP, permissions |
| `src/lib/itsm/` | Vocabulary, workflow, access rules, SLA engine and clock, ticket service, approvals, maintenance windows, notification routing |
| `src/lib/cmdb/`, `src/lib/kb/`, `src/lib/catalog/`, `src/lib/endpoints/` | Module services |
| `src/lib/email/` | Templates, outbox delivery, email-to-ticket |
| `src/lib/jobs/` | Queue, worker, handler registration |
| `src/lib/files/` | Storage, type sniffing, ClamAV |
| `src/app/(auth)/` | Sign-in, MFA, reset and invite pages |
| `src/app/(app)/` | The application (dashboard, tickets, approvals, catalog, KB, CMDB, endpoints, patches, reports, admin) |
| `src/app/api/` | REST API, agent API, downloads, exports, OIDC, health |
| `agent/` | Windows and Linux agents |
| `scripts/` | Migrate, seed, licence tool, backups, legacy import |

## Security model in one paragraph

Every request is authenticated by a session cookie (httpOnly, SameSite=Lax, Secure behind
HTTPS; SHA-256 stored server-side, MFA step-up) or an API token (hashed). Every service function
receives the actor, filters every query by the actor's tenant and checks a named permission. A
super admin works in one selected tenant at a time. Agents authenticate with a per-device secret
(hashed) obtained with an expiring, usage-limited enrolment token; they only pull work and
cannot reach other devices or tenants. Security-relevant events are written to an append-only,
hash-chained audit log. Secrets at rest (MFA seeds, LDAP/SMTP/IMAP passwords, OIDC client secrets)
are encrypted with AES-256-GCM using a key derived from `APP_SECRET`.
