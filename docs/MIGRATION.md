# Migrating data from the old helpdesk

The old helpdesk ran on Supabase (PostgreSQL + GoTrue auth + Storage). This product imports
its data from **pg_dump files**, so the import never connects to the old production
project. The dump folder is mounted read-only. Nothing in the old project is changed.

## Quickest: pull straight from the live project

While the old Supabase project is still running, one command does steps 1–6 below:

```powershell
npm run legacy:pull -- -EnvFile "E:\cgb-code\CGB-Helpdesk-latest\.env"
```

It reads `PROD_DB_URL`, `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from that file
(read only; nothing is printed). It takes a read-only `pg_dump` snapshot, stages it, imports it,
copies the attachment files, then deletes the staging container and the snapshot files.
Supabase's direct host is IPv6-only, so the script connects through the IPv4 session pooler
(`-PoolerHost`, default `aws-1-ap-south-1.pooler.supabase.com`). Add `-DryRun` to see counts only.

The importer only **adds** rows it has not seen. To refresh a trial copy so that tickets changed
since the last pull show their current state, recreate the target database first (dev only:
`docker exec itsm-dev-db psql -U itsm -d postgres -c "drop database itsm" -c "create database itsm owner itsm"`,
with the app stopped), then pull. Live pull of 26 Nov 2026: 2 tenants, 12 organisations,
82 people (all with password hashes), 57 tickets, 135 history entries, 110 SLA clocks,
1,932 CIs, 6 of 6 attachment files.

## Steps (from dump files)

1. **Take fresh dumps** of the old project (an administrator of the old project does this):
   - `public` schema with data (business tables);
   - `auth.users` with data (so people keep their passwords; GoTrue stores bcrypt hashes).

   The files already on disk from 12 Nov 2026 work for a trial:
   `prod-before-itsm-20261112-064712.dump` (data) and `prod-20261112-002330.dump` (auth.users).

2. **Stage** the dumps into a throwaway local PostgreSQL 17 container (needs Docker):
   ```powershell
   npm run legacy:stage -- -DumpDir "E:\cgb-code\CGB-Helpdesk-latest\backups"
   ```
   This picks the newest `*before-itsm*.dump` for data and the newest dump that contains
   `auth.users`. Override with `-DataDump <file>` / `-AuthDump <file>`. Around 18 restore errors
   about Supabase-only objects (policies, functions, roles) are expected and harmless.

3. **Dry run** (shows counts, saves nothing):
   ```
   npm run legacy:import -- --timezone Asia/Kolkata --dry-run
   ```
4. **Import:**
   ```
   npm run legacy:import -- --timezone Asia/Kolkata
   ```
   Re-running is safe: rows already imported (same UUID) are skipped.

5. **Attachment files** live in Supabase Storage, not in the dump. While the old project is
   still reachable, copy them:
   ```
   LEGACY_SUPABASE_URL=https://<project>.supabase.co LEGACY_SUPABASE_SERVICE_KEY=<service key> npx tsx scripts/legacy/fetch-attachments.ts
   ```
   Until then they show as "not migrated" on the ticket.

6. **Remove the staging container:** `npm run legacy:unstage`. The staging connection file
   `data/legacy-staging-url.txt` holds only a throwaway password for that container; delete it too.

7. **Check** a few tickets, assets and people in the UI, and run `npm run audit:verify`.

## What is mapped where

| Old | New | Notes |
|---|---|---|
| `tenants` | `tenants` (+ default configuration) | Same id, name and slug. The time zone comes from `--timezone` (the old default was Asia/Kolkata). SLA defaults reproduce the old behaviour: respond 15 min, resolve 6 h, 24×7, for incidents and requests. |
| `organizations` | `organizations` | Same ids. |
| `users` + `auth.users` | `users` | Same ids. Email (lower case), name, role (`user` / `engineer` / `admin` / `superadmin`), phone, employee id, designation/position, department, city → location, organisation, time zone. The **bcrypt password hash** is kept, so people sign in with their current password; hashes are upgraded to cost 12 at the next sign-in. Banned or deleted accounts are imported as disabled. A free-text manager is linked when it matches exactly one person. |
| — (not imported) | — | **Date of birth, present/permanent address, postal code, country** are left out (data minimisation; not needed for IT service management). Notifications are transient. AskMira connector tables (`askmira_*`) are not imported; the connector is not part of this product. `user_organization_access` was already retired. `asset_activity_log` was unused. |
| `tickets` | `tickets` (type incident) | Same ids. Numbers `INC0001001…` in the order raised (the same numbering the old ITSM migration would have produced). Status: `new` → New, `open`/`in_progress` → In progress, `hold` → On hold, `closed` → Closed. Free-text categories map onto the category tree, and unknown names are added as categories. Impact and urgency are kept only when valid. `closed_comment` → closing note, `hold_comment` → hold reason. `inventory`, `link`, `cc` and the raw old status are kept in `tickets.legacy`. Source = `migration`. |
| SLA columns | `ticket_sla` clocks + ticket summary | Old deadlines are kept as they were (historical, not recomputed). Closed tickets get met/breached clocks; open tickets keep running clocks (paused while on hold). |
| `ticket_messages` | `ticket_comments` (public) | Author kept. |
| `ticket_activity` | `ticket_activity` | Kept as history (`details.legacy_action` holds the original action). |
| `ticket_assignments` | `ticket_assignments` | |
| `ticket_attachments` | `files` (records) | The bytes are fetched separately (step 5). |
| `assets` | `configuration_items` | Same ids. `asset_code` → CI code (duplicates get a `-DUP2` suffix). `asset_type` (free text) → CI class (laptop, desktop, server, monitor, printer, mobile, network device, peripheral, …); the original text is kept in `attributes.legacy_type`. `spare` → In stock. Model, serial, location, room, department, purchase and warranty data, owner, organisation. |
| `asset_details` | `configuration_items.attributes` | cpu, ram, storage, os_name, mac_address, vendor, … |
| `parent_asset_id` | `ci_relationships` (`contains`) | |
| `asset_assignments` | `ci_assignments` | Only the latest open assignment per CI stays open. |
| `asset_tickets` | `ticket_cis` (affected) | |

## Trial import result (dumps of 12 Nov 2026, run 26 Nov 2026)

| | Imported |
|---|---|
| Tenants | 1 |
| Organisations | 9 |
| People | 30 (all with their password hash) |
| Tickets | 15 (9 closed, 2 in progress, 4 new) |
| Comments / history entries / assignment records | 5 / 29 / 3 |
| SLA clocks | 22 |
| Attachment records | 3 (files still in Supabase Storage) |
| Configuration items (from assets) | 1,932 |
| CI assignment records | 13 |
| People whose HR fields were left out | 10 |

## Cut-over plan (suggested)

1. Announce a short freeze on the old helpdesk (it is small: minutes, not hours).
2. Take fresh dumps (step 1), stage and import into the production instance.
3. Copy the attachment files (step 5).
4. Point the support mailbox at email-to-ticket (Admin › Email) and send people the new URL.
   Their passwords still work.
5. Keep the old project read-only for a retention period, then decommission it. Rotate its
   service-role key and database password (see the security findings in `GAP_ASSESSMENT.md`).
