# Operations guide (on-prem)

## Requirements
- A Linux or Windows server with Docker (Compose v2). Sizing guide: 2 vCPU, 4 GB RAM and 40 GB disk
  for up to about 2,000 users and 2,000 endpoints. Add disk for attachments and offline patch packages.
- A DNS name for the service (for example `itsm.corp.local`) and a TLS certificate for it.
- Outbound SMTP (and IMAP for email-to-ticket) to your mail server, if email is used.
- Endpoints need outbound HTTPS to the server only.

## Install
```bash
cp .env.production.example .env        # set APP_URL, POSTGRES_PASSWORD, APP_SECRET, BOOTSTRAP_*
mkdir -p keys && cp license-public.pem keys/   # licence public key from the vendor (optional)
docker compose build                    # or: docker load < itsm-images.tar.gz (air-gapped)
docker compose up -d
# HTTPS: put fullchain.pem + privkey.pem in deploy/certs/, set the host name in deploy/Caddyfile, then
docker compose --profile tls up -d
```
On first start the app applies database migrations and, if the database is empty, creates the
first tenant and a super admin from `BOOTSTRAP_*` (that password must be changed at first sign-in).
Then remove `BOOTSTRAP_ADMIN_PASSWORD` from `.env`.

Generate secrets with `openssl rand -base64 32`. **Back up `APP_SECRET`**: it decrypts the MFA seeds
and the stored LDAP/SMTP/IMAP/OIDC passwords.

## Air-gapped sites
- Build or pull images on a connected machine, then
  `docker save itsm-platform:<ver> postgres:17-alpine caddy:2-alpine | gzip > itsm-images.tar.gz`. Copy the
  file across and run `docker load < itsm-images.tar.gz`.
- Nothing calls the internet at run time: there are no CDNs, web fonts, telemetry or licence phone-home.
- Patches: Windows agents use the update source configured on the device (WSUS by group policy, or
  Microsoft Update). For fully offline networks, upload update packages (`.msu`, `.cab`, `.msi`, `.exe`,
  `.deb`, `.rpm`) to a patch in *Patches › patch › Offline package*. Agents then download them from this
  server, verify the SHA-256 and install them.

## Configuration after install
1. *Administration › Settings*: branding, sign-in policy (require MFA, password length, session length).
2. *Administration › Email*: SMTP for outgoing mail, IMAP mailbox for email-to-ticket, test email.
3. *Administration › Sign-in providers*: LDAP / Active Directory (bind account, base DN, group → role
   mapping) and/or OIDC (Entra ID, Keycloak, …).
4. *Administration › ITSM*: categories, priority matrix, SLA/OLA, business hours and holidays, custom
   fields, email templates, maintenance windows.
5. *Administration › Users / Groups*: assignment groups, CAB members, approvers.
6. *Endpoints › Enrol devices*: create an enrolment token, deploy the agent (see `agent/README.md`).

## Backup and restore
- **Backup:** `./scripts/backup.sh /srv/backups` (Linux) or `scripts\backup.ps1 -Dir D:\backups` (Windows).
  This writes the database (pg_dump custom format) and the files volume. Schedule it daily (cron or Task
  Scheduler) and copy the output off the server. Keep `APP_SECRET` and `.env` with the backups, securely.
- **Restore:**
  ```bash
  docker compose stop app
  docker compose exec -T db dropdb -U itsm itsm && docker compose exec -T db createdb -U itsm itsm
  docker compose exec -T db pg_restore -U itsm -d itsm --no-owner < backups/itsm-db-<stamp>.dump
  docker compose run --rm -T app sh -c "rm -rf /data/files/* && tar -C /data -xzf -" < backups/itsm-files-<stamp>.tar.gz
  docker compose start app
  ```
- Test a restore on a spare machine at least once a quarter.

## Upgrades
1. Back up (above).
2. `docker compose pull` (or `docker load` the new image), then `docker compose up -d`.
3. The new version applies its migrations at start under an advisory lock (replica-safe). Watch
   `GET /api/ready`: it returns 503 with `migrations_pending` until the schema is current.
4. Migrations are forward-only. To roll back, restore the pre-upgrade backup and run the previous
   image.

## Monitoring
- `GET /api/health`: liveness (the process answers).
- `GET /api/ready`: readiness (database reachable, schema current, overdue jobs count).
- Logs: one JSON object per line on stdout (`docker compose logs app`). Ship them to your SIEM. They
  contain ids, not email addresses or secrets.
- *Administration › System*: version, migrations, job queue (with retry of dead jobs) and email outbox.
- The audit log (*Reports › Audit log*) is append-only and hash-chained. Run "Verify integrity" there,
  or `docker compose exec app node -e "…"` / `npm run audit:verify` from a dev checkout.

## Scaling and high availability
- The app is stateless apart from the files volume. Run more `app` replicas behind the proxy with shared
  storage for `/data/files` (NFS, or S3-compatible storage in a later release). The job queue and
  scheduled tasks are safe with several replicas (`FOR UPDATE SKIP LOCKED`, one run per time slot).
- PostgreSQL HA uses the usual tools (streaming replication with Patroni, or a managed on-prem cluster).
  Point `DATABASE_URL` at the primary.

## Licensing
- The vendor creates a key pair once (`npm run license:keygen`, kept by the vendor) and ships
  `license-public.pem` with the product.
- For each customer, the vendor issues `npm run license:issue -- --licensee "Customer" --devices 500 --days 365`.
  The customer pastes the text into *Administration › Licence*.
- Without a licence, the app runs in evaluation mode (25 managed devices). When the licence expires,
  ITSM keeps working; only enrolling new devices is blocked.

## Security checklist
- Serve only over HTTPS (`APP_URL=https://…`); this enables Secure cookies and HSTS.
- Keep the database port unexposed (the compose file does not publish it).
- Require MFA for administrators (*Settings*), or use an IdP with MFA.
- Rotate API tokens and enrolment tokens; revoke unused ones.
- Restrict `endpoint.run_script` to as few people as possible. Every script run is audited.
- Enable ClamAV (`--profile av`, `CLAMAV_ADDRESS=clamav:3310`) where attachments come from outside.
