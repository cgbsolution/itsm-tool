-- =============================================================================
-- 0001 Platform: tenants, people, sign-in, roles, groups, audit, jobs, files,
-- notifications, email, licence. Applied by src/lib/db/migrate.ts inside one
-- transaction and recorded in schema_migrations.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 200),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  created_at  timestamptz not null default now()
);

create table tenant_settings (
  tenant_id                 uuid primary key references tenants(id) on delete cascade,
  -- working calendar (business-hours SLAs)
  timezone                  text not null default 'UTC',
  work_days                 smallint[] not null default array[1, 2, 3, 4, 5]::smallint[],
  work_start                time not null default '09:00',
  work_end                  time not null default '18:00',
  holidays                  date[] not null default array[]::date[],
  -- branding (no product or customer names are hard-coded)
  brand_name                text,
  brand_color               text not null default '#2563eb' check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  support_email             text,
  -- ticket behaviour
  hold_max_hours            integer not null default 72 check (hold_max_hours between 1 and 8760),
  reopen_window_days        integer not null default 7 check (reopen_window_days between 0 and 365),
  auto_close_resolved_days  integer not null default 3 check (auto_close_resolved_days between 0 and 365),
  strict_assignment         boolean not null default true,  -- only the assignee (or an admin) works a ticket
  -- sign-in policy
  require_mfa               boolean not null default false,
  password_min_length       integer not null default 10 check (password_min_length between 8 and 128),
  session_hours             integer not null default 12 check (session_hours between 1 and 720),
  -- email-to-ticket: create a requester account for unknown senders
  inbound_create_users      boolean not null default false,
  updated_at                timestamptz not null default now(),
  check (work_end > work_start),
  check (work_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

-- Client companies inside a tenant (a label; not an access boundary)
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  domain      text,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now()
);
create unique index organizations_tenant_name_key on organizations (tenant_id, lower(name));

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table users (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete restrict,
  email                 text not null check (email ~ '^[^@\s]+@[^@\s]+$'),
  full_name             text not null default '',
  role                  text not null default 'user',     -- system role key or custom_roles.key
  status                text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  auth_source           text not null default 'local' check (auth_source in ('local', 'ldap', 'oidc')),
  password_hash         text,                             -- bcrypt; null = cannot sign in with a password
  password_changed_at   timestamptz,
  must_change_password  boolean not null default false,
  mfa_enabled           boolean not null default false,
  mfa_secret_enc        text,                             -- AES-256-GCM with APP_SECRET
  mfa_recovery_hashes   text[] not null default array[]::text[],
  failed_logins         integer not null default 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  last_seen_at          timestamptz,
  phone                 text,
  employee_id           text,
  designation           text,
  department            text,
  location              text,
  manager_id            uuid references users(id) on delete set null,
  organization_id       uuid references organizations(id) on delete set null,
  timezone              text,
  external_id           text,                             -- LDAP DN, OIDC subject or HR id
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));
create index users_tenant_idx on users (tenant_id, role);

-- Custom roles (system roles user / engineer / admin / superadmin are defined in code)
create table custom_roles (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name         text not null,
  description  text,
  permissions  text[] not null default array[]::text[],
  created_at   timestamptz not null default now(),
  unique (tenant_id, key)
);

-- Teams: support / assignment groups, CAB, approver groups
create table groups (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 120),
  description  text,
  email        text,
  kind         text not null default 'support' check (kind in ('support', 'cab', 'approvers', 'other')),
  manager_id   uuid references users(id) on delete set null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index groups_tenant_name_key on groups (tenant_id, lower(name));

create table group_members (
  group_id  uuid not null references groups(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on group_members (user_id);

-- ---------------------------------------------------------------------------
-- Sign-in
-- ---------------------------------------------------------------------------
create table sessions (
  id             text primary key,                 -- sha256 of the cookie token
  user_id        uuid not null references users(id) on delete cascade,
  mfa_pending    boolean not null default false,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  last_seen_at   timestamptz not null default now(),
  ip             text,
  user_agent     text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expiry_idx on sessions (expires_at);

-- Password reset and invitation links
create table auth_tokens (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  purpose     text not null check (purpose in ('reset', 'invite')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- External identity providers per tenant (LDAP / Active Directory, OIDC)
create table auth_providers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null check (kind in ('ldap', 'oidc')),
  name        text not null,
  enabled     boolean not null default false,
  config      jsonb not null default '{}'::jsonb,    -- non-secret settings
  secret_enc  text,                                  -- bind password / client secret (encrypted)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Personal access tokens for the REST API (integrations, HR sync, monitoring)
create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade, -- acts as this user
  name          text not null,
  token_hash    text not null unique,
  prefix        text not null,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table rate_limits (
  key           text primary key,
  window_start  timestamptz not null,
  hits          integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained. UPDATE / DELETE / TRUNCATE are refused.
-- ---------------------------------------------------------------------------
create table audit_log (
  id           bigint primary key,
  tenant_id    uuid references tenants(id) on delete restrict,
  actor_id     uuid,
  actor_label  text,
  action       text not null,
  entity_type  text,
  entity_id    text,
  summary      text,
  data         jsonb,
  ip           text,
  created_at   timestamptz not null default now(),
  prev_hash    text not null default '',
  hash         text not null default ''
);
create sequence audit_log_id_seq owned by audit_log.id;
create index audit_log_tenant_idx on audit_log (tenant_id, created_at desc);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);

create function audit_log_hash_input(r audit_log) returns text
language sql immutable as $$
  select concat_ws('|',
    r.id::text, r.prev_hash, coalesce(r.tenant_id::text, ''), coalesce(r.actor_id::text, ''),
    coalesce(r.actor_label, ''), r.action, coalesce(r.entity_type, ''), coalesce(r.entity_id, ''),
    coalesce(r.summary, ''), coalesce(r.data::text, ''), coalesce(r.ip, ''),
    to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))
$$;

create function audit_log_chain() returns trigger
language plpgsql as $$
declare
  _prev text;
begin
  -- one writer at a time, so ids and the chain stay in the same order
  perform pg_advisory_xact_lock(7311001);
  new.id := nextval('audit_log_id_seq');
  new.created_at := coalesce(new.created_at, now());
  select hash into _prev from audit_log order by id desc limit 1;
  new.prev_hash := coalesce(_prev, '');
  new.hash := encode(sha256(convert_to(audit_log_hash_input(new), 'UTF8')), 'hex');
  return new;
end $$;

create trigger audit_log_chain before insert on audit_log
  for each row execute function audit_log_chain();

create function audit_log_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;

create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_immutable();

-- ---------------------------------------------------------------------------
-- Background jobs (Postgres queue: FOR UPDATE SKIP LOCKED, retries, dead letter)
-- ---------------------------------------------------------------------------
create table jobs (
  id            bigserial primary key,
  kind          text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead')),
  run_at        timestamptz not null default now(),
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  last_error    text,
  locked_by     text,
  locked_at     timestamptz,
  dedupe_key    text unique,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index jobs_ready_idx on jobs (run_at) where status = 'queued';
create index jobs_running_idx on jobs (locked_at) where status = 'running';

-- ---------------------------------------------------------------------------
-- Files (local disk / S3-compatible storage; metadata here)
-- ---------------------------------------------------------------------------
create table files (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  entity_type   text not null check (entity_type in ('ticket', 'comment', 'kb_article', 'patch_package', 'import')),
  entity_id     uuid,
  storage_key   text,                      -- null when the bytes were not migrated yet
  file_name     text not null,
  content_type  text not null default 'application/octet-stream',
  size_bytes    bigint not null default 0,
  sha256        text,
  scan_status   text not null default 'not_scanned' check (scan_status in ('not_scanned', 'clean', 'infected', 'error')),
  uploaded_by   uuid references users(id) on delete set null,
  legacy_path   text,
  created_at    timestamptz not null default now()
);
create index files_entity_idx on files (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Notifications and email
-- ---------------------------------------------------------------------------
create table notifications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  actor_id     uuid references users(id) on delete set null,
  kind         text not null,
  title        text not null,
  body         text,
  link         text,
  entity_type  text,
  entity_id    uuid,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, is_read, created_at desc);

create table email_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key         text not null,
  subject     text not null,
  body        text not null,       -- plain text with {{placeholders}}; rendered into the HTML layout
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

-- Every outgoing email, with delivery status
create table email_outbox (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade,
  to_address    text not null,
  subject       text not null,
  body_text     text not null,
  body_html     text not null,
  headers       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts      integer not null default 0,
  last_error    text,
  related_type  text,
  related_id    uuid,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index email_outbox_tenant_idx on email_outbox (tenant_id, created_at desc);

-- SMTP / IMAP per tenant (falls back to SMTP_* environment settings)
create table tenant_mail_settings (
  tenant_id           uuid primary key references tenants(id) on delete cascade,
  smtp_host           text,
  smtp_port           integer,
  smtp_secure         boolean not null default false,
  smtp_user           text,
  smtp_password_enc   text,
  from_address        text,
  imap_enabled        boolean not null default false,
  imap_host           text,
  imap_port           integer default 993,
  imap_secure         boolean not null default true,
  imap_user           text,
  imap_password_enc   text,
  imap_folder         text not null default 'INBOX',
  imap_last_poll_at   timestamptz,
  imap_last_error     text,
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Licence and instance settings
-- ---------------------------------------------------------------------------
create table license (
  id            integer primary key default 1 check (id = 1),
  license_text  text not null,
  installed_at  timestamptz not null default now(),
  installed_by  uuid references users(id) on delete set null
);

create table system_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Per-tenant numbering for tickets (INC/REQ/PRB/CHG) and KB articles
create table tenant_counters (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  record_type  text not null,
  last_value   bigint not null default 1000,
  primary key (tenant_id, record_type)
);

create function next_number(_tenant uuid, _type text, _prefix text) returns text
language plpgsql as $$
declare
  _n bigint;
begin
  insert into tenant_counters as c (tenant_id, record_type, last_value)
  values (_tenant, _type, 1001)
  on conflict (tenant_id, record_type) do update set last_value = c.last_value + 1
  returning last_value into _n;
  return _prefix || lpad(_n::text, 7, '0');
end $$;
