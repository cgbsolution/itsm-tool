-- =============================================================================
-- 0004 Endpoints and patch management: device groups (deployment rings),
-- enrolment tokens, devices, software inventory, patch catalog and per-device
-- state, patch policies, deployments, and the agent job queue.
-- Protocol: docs/AGENT_PROTOCOL.md
-- =============================================================================

create table device_groups (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  description  text,
  ring         integer not null default 1 check (ring between 0 and 9),   -- 0 = pilot, higher = later
  created_at   timestamptz not null default now()
);
create unique index device_groups_name_key on device_groups (tenant_id, lower(name));

create table enrollment_tokens (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  token_hash  text not null unique,
  prefix      text not null,
  group_id    uuid references device_groups(id) on delete set null,
  expires_at  timestamptz,
  max_uses    integer,
  uses        integer not null default 0,
  revoked_at  timestamptz,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table devices (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete restrict,
  hostname           text not null,
  os_family          text not null default 'other' check (os_family in ('windows', 'linux', 'macos', 'other')),
  os_name            text,
  os_version         text,
  os_build           text,
  arch               text,
  domain             text,
  agent_version      text,
  secret_hash        text not null,
  status             text not null default 'active' check (status in ('active', 'retired')),
  group_id           uuid references device_groups(id) on delete set null,
  tags               text[] not null default array[]::text[],
  ci_id              uuid references configuration_items(id) on delete set null,
  manufacturer       text,
  model              text,
  serial_no          text,
  cpu                text,
  cpu_cores          integer,
  ram_mb             integer,
  disk_total_gb      numeric(12, 1),
  disk_free_gb       numeric(12, 1),
  mac_addresses      text[] not null default array[]::text[],
  ip_addresses       text[] not null default array[]::text[],
  logged_on_user     text,
  uptime_seconds     bigint,
  reboot_pending     boolean not null default false,
  inventory          jsonb not null default '{}'::jsonb,
  last_seen_at       timestamptz,
  last_ip            text,
  last_inventory_at  timestamptz,
  last_scan_at       timestamptz,
  enrolled_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index devices_tenant_idx on devices (tenant_id, status, hostname);
create index devices_group_idx on devices (group_id);

create table device_software (
  device_id     uuid not null references devices(id) on delete cascade,
  name          text not null,
  version       text not null default '',
  publisher     text,
  installed_on  date,
  primary key (device_id, name, version)
);
create index device_software_name_idx on device_software (lower(name));

-- Patch catalog per tenant, built from agent scan reports (and offline packages)
create table patches (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  os_family        text not null check (os_family in ('windows', 'linux', 'macos', 'other')),
  source           text not null check (source in ('windows_update', 'apt', 'dnf', 'yum', 'zypper', 'macos', 'package')),
  external_id      text not null,
  kb               text,
  title            text not null,
  description      text,
  classification   text not null default 'other' check (classification in ('security', 'critical', 'update', 'feature', 'driver', 'definition', 'other')),
  severity         text not null default 'unspecified' check (severity in ('critical', 'important', 'moderate', 'low', 'unspecified')),
  version          text,
  release_date     date,
  size_bytes       bigint,
  reboot_required  boolean not null default false,
  support_url      text,
  approval         text not null default 'pending' check (approval in ('pending', 'approved', 'declined')),
  approved_by      uuid references users(id) on delete set null,
  approved_at      timestamptz,
  package_file_id  uuid references files(id) on delete set null,   -- offline / air-gapped repository
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, os_family, source, external_id)
);
create index patches_tenant_idx on patches (tenant_id, approval, severity);

create table device_patches (
  device_id     uuid not null references devices(id) on delete cascade,
  patch_id      uuid not null references patches(id) on delete cascade,
  state         text not null check (state in ('missing', 'installed', 'failed', 'pending_reboot')),
  detected_at   timestamptz not null default now(),
  installed_at  timestamptz,
  last_error    text,
  updated_at    timestamptz not null default now(),
  primary key (device_id, patch_id)
);
create index device_patches_patch_idx on device_patches (patch_id, state);

create table patch_policies (
  id                            uuid primary key default gen_random_uuid(),
  tenant_id                     uuid not null references tenants(id) on delete cascade,
  name                          text not null,
  description                   text,
  device_group_id               uuid references device_groups(id) on delete cascade,   -- null = every device
  auto_approve_classifications  text[] not null default array[]::text[],
  auto_approve_delay_days       integer not null default 0 check (auto_approve_delay_days between 0 and 365),
  schedule_days                 smallint[] not null default array[]::smallint[],   -- 0 = Sunday; empty = no automatic deployment
  schedule_time                 time not null default '02:00',
  maintenance_window_id         uuid references maintenance_windows(id) on delete set null,
  reboot_behavior               text not null default 'if_required' check (reboot_behavior in ('never', 'if_required', 'always')),
  is_active                     boolean not null default true,
  last_run_at                   timestamptz,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create table patch_deployments (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants(id) on delete cascade,
  name                   text not null,
  description            text,
  status                 text not null default 'draft' check (status in ('draft', 'scheduled', 'running', 'completed', 'cancelled')),
  patch_ids              uuid[] not null default array[]::uuid[],
  target_device_ids      uuid[] not null default array[]::uuid[],
  target_group_ids       uuid[] not null default array[]::uuid[],
  scheduled_at           timestamptz,
  maintenance_window_id  uuid references maintenance_windows(id) on delete set null,
  reboot_behavior        text not null default 'if_required' check (reboot_behavior in ('never', 'if_required', 'always')),
  change_id              uuid references tickets(id) on delete set null,   -- the approved change it implements
  policy_id              uuid references patch_policies(id) on delete set null,
  created_by             uuid references users(id) on delete set null,
  created_at             timestamptz not null default now(),
  started_at             timestamptz,
  completed_at           timestamptz
);
create index patch_deployments_tenant_idx on patch_deployments (tenant_id, status, created_at desc);

-- Work for agents. Agents long-poll /api/agent/v1/jobs.
create table agent_jobs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  device_id      uuid not null references devices(id) on delete cascade,
  kind           text not null check (kind in ('inventory', 'scan', 'install_patches', 'run_script', 'reboot', 'update_agent')),
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'queued' check (status in ('queued', 'dispatched', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  deployment_id  uuid references patch_deployments(id) on delete set null,
  created_by     uuid references users(id) on delete set null,
  not_before     timestamptz not null default now(),
  expires_at     timestamptz,
  dispatched_at  timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  exit_code      integer,
  output         text,
  result         jsonb,
  created_at     timestamptz not null default now()
);
create index agent_jobs_device_idx on agent_jobs (device_id, status, not_before);
create index agent_jobs_deployment_idx on agent_jobs (deployment_id);
