-- =============================================================================
-- 0003 CMDB: CI classes with attribute schemas, configuration items, typed
-- relationships, assignment history, ticket links, change history.
-- Legacy assets load as CIs (asset_code -> ci_code, asset_details -> attributes).
-- =============================================================================

create table ci_classes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  name         text not null,
  category     text not null default 'hardware' check (category in ('hardware', 'software', 'service', 'network', 'facility', 'other')),
  -- attribute schema: [{ key, label, type: text|number|date|select|boolean, options?, required? }]
  attributes   jsonb not null default '[]'::jsonb,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (tenant_id, key)
);

create table configuration_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete restrict,
  class_id          uuid not null references ci_classes(id) on delete restrict,
  ci_code           text not null check (length(trim(ci_code)) between 1 and 64),
  name              text not null,
  status            text not null default 'in_use' check (status in ('planned', 'in_stock', 'in_use', 'maintenance', 'retired', 'disposed')),
  condition         text check (condition is null or condition in ('new', 'good', 'fair', 'poor', 'damaged')),
  environment       text check (environment is null or environment in ('production', 'staging', 'test', 'development')),
  criticality       text check (criticality is null or criticality in ('low', 'medium', 'high', 'critical')),
  owner_id          uuid references users(id) on delete set null,       -- person using it
  support_group_id  uuid references groups(id) on delete set null,
  organization_id   uuid references organizations(id) on delete set null,
  location          text,
  room              text,
  department        text,
  manufacturer      text,
  model             text,
  serial_no         text,
  purchase_date     date,
  warranty_years    integer,
  warranty_expiry   date,
  cost              numeric(14, 2),
  attributes        jsonb not null default '{}'::jsonb,
  notes             text,
  source            text not null default 'manual' check (source in ('manual', 'import', 'agent', 'api', 'migration')),
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search            tsvector generated always as (
                      to_tsvector('simple', coalesce(ci_code, '') || ' ' || coalesce(name, '') || ' ' ||
                                  coalesce(serial_no, '') || ' ' || coalesce(model, '') || ' ' || coalesce(location, ''))
                    ) stored
);
create unique index configuration_items_code_key on configuration_items (tenant_id, upper(trim(ci_code)));
create index configuration_items_class_idx on configuration_items (tenant_id, class_id, status);
create index configuration_items_owner_idx on configuration_items (owner_id);
create index configuration_items_search_idx on configuration_items using gin (search);

create table ci_relationships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  source_id   uuid not null references configuration_items(id) on delete cascade,
  target_id   uuid not null references configuration_items(id) on delete cascade,
  rel_type    text not null check (rel_type in ('depends_on', 'runs_on', 'hosted_on', 'connected_to', 'contains', 'installed_on', 'uses', 'backs_up', 'member_of')),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  check (source_id <> target_id),
  unique (source_id, target_id, rel_type)
);
create index ci_relationships_target_idx on ci_relationships (target_id);

create table ci_assignments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete restrict,
  ci_id        uuid not null references configuration_items(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  assigned_by  uuid references users(id) on delete set null,
  assigned_at  timestamptz not null default now(),
  returned_at  timestamptz,
  note         text
);
create unique index ci_assignments_one_open on ci_assignments (ci_id) where returned_at is null;

create table ticket_cis (
  ticket_id  uuid not null references tickets(id) on delete cascade,
  ci_id      uuid not null references configuration_items(id) on delete cascade,
  role       text not null default 'affected' check (role in ('affected', 'caused_by', 'changed', 'related')),
  linked_by  uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (ticket_id, ci_id)
);
create index ticket_cis_ci_idx on ticket_cis (ci_id);

create table ci_history (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  ci_id       uuid not null references configuration_items(id) on delete cascade,
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  changes     jsonb,
  created_at  timestamptz not null default now()
);
create index ci_history_ci_idx on ci_history (ci_id, created_at desc);
