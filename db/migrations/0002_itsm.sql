-- =============================================================================
-- 0002 ITSM: record types, categories, priority matrix, SLA/OLA, custom fields,
-- tickets and their conversation/history, approvals (CAB), maintenance windows,
-- service catalog, knowledge base.
-- Concepts carried over from the legacy itsm_core migration (types, numbering,
-- categories, matrix, sla_policies, tenant calendar, ticket_links).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Classification
-- ---------------------------------------------------------------------------
create table ticket_categories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  parent_id     uuid references ticket_categories(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 100),
  ticket_types  text[],          -- null = offered for every record type
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  check (ticket_types is null or ticket_types <@ array['incident', 'service_request', 'problem', 'change']::text[])
);
create unique index ticket_categories_name_key
  on ticket_categories (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index ticket_categories_tenant_idx on ticket_categories (tenant_id, parent_id, sort_order);

create table priority_matrix (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  impact     text not null check (impact in ('low', 'medium', 'high')),
  urgency    text not null check (urgency in ('low', 'medium', 'high')),
  priority   text not null check (priority in ('low', 'medium', 'high', 'critical')),
  primary key (tenant_id, impact, urgency)
);

-- SLA (customer-facing) and OLA (per support group) targets.
-- ticket_type null = default for every type without its own policy.
create table sla_policies (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  kind                text not null default 'sla' check (kind in ('sla', 'ola')),
  ticket_type         text check (ticket_type is null or ticket_type in ('incident', 'service_request', 'problem', 'change')),
  priority            text not null check (priority in ('low', 'medium', 'high', 'critical')),
  group_id            uuid references groups(id) on delete cascade,   -- OLA: the support group it applies to
  response_minutes    integer not null check (response_minutes between 1 and 525600),
  resolution_minutes  integer not null check (resolution_minutes between 1 and 525600),
  business_hours      boolean not null default false,
  warn_percent        integer not null default 75 check (warn_percent between 10 and 99),
  is_active           boolean not null default true,
  updated_at          timestamptz not null default now(),
  check (kind = 'sla' or group_id is not null)
);
create unique index sla_policies_key
  on sla_policies (tenant_id, kind, coalesce(ticket_type, '*'), priority,
                   coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Tenant-defined fields on tickets (values live in tickets.custom)
create table custom_fields (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  key           text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label         text not null,
  field_type    text not null check (field_type in ('text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox', 'email')),
  options       text[] not null default array[]::text[],
  required      boolean not null default false,
  ticket_types  text[],          -- null = all types
  help_text     text,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- Service catalog (needed before tickets reference it)
-- ---------------------------------------------------------------------------
create table catalog_categories (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  description  text,
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index catalog_categories_name_key on catalog_categories (tenant_id, lower(name));

create table catalog_items (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  category_id          uuid references catalog_categories(id) on delete set null,
  name                 text not null,
  short_description    text,
  description          text,
  -- form definition: [{ key, label, type, required, options, help }]
  form_fields          jsonb not null default '[]'::jsonb,
  requires_approval    boolean not null default false,
  approval_mode        text not null default 'any' check (approval_mode in ('any', 'all')),
  approver_group_id    uuid references groups(id) on delete set null,
  approve_by_manager   boolean not null default false,
  fulfilment_group_id  uuid references groups(id) on delete set null,
  ticket_category_id   uuid references ticket_categories(id) on delete set null,
  default_priority     text not null default 'medium' check (default_priority in ('low', 'medium', 'high', 'critical')),
  -- tasks created when the request is approved: [{ title, group_id? }]
  task_templates       jsonb not null default '[]'::jsonb,
  visibility           text not null default 'all' check (visibility in ('all', 'staff')),
  sort_order           integer not null default 0,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index catalog_items_tenant_idx on catalog_items (tenant_id, category_id, sort_order);

-- ---------------------------------------------------------------------------
-- Tickets: one table, four record types with their own workflows (in code).
-- ---------------------------------------------------------------------------
create table tickets (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id) on delete restrict,
  number                   text not null,
  ticket_type              text not null check (ticket_type in ('incident', 'service_request', 'problem', 'change')),
  status                   text not null check (status in (
                             'draft', 'new', 'assessment', 'pending_approval', 'approved', 'scheduled',
                             'in_progress', 'investigating', 'known_error', 'implementing', 'review',
                             'on_hold', 'resolved', 'closed', 'rejected', 'cancelled')),
  subject                  text not null check (length(trim(subject)) between 1 and 300),
  description              text,
  source                   text not null default 'portal' check (source in ('portal', 'email', 'phone', 'agent', 'api', 'monitoring', 'migration')),
  requester_id             uuid references users(id) on delete set null,
  requester_name           text,          -- as given at the time (legacy rows, email senders)
  created_by               uuid references users(id) on delete set null,
  organization_id          uuid references organizations(id) on delete set null,
  contact                  text,
  location                 text,
  -- classification
  category_id              uuid references ticket_categories(id) on delete set null,
  category                 text,
  sub_category             text,
  impact                   text check (impact is null or impact in ('low', 'medium', 'high')),
  urgency                  text check (urgency is null or urgency in ('low', 'medium', 'high')),
  priority                 text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  -- assignment
  assignment_group_id      uuid references groups(id) on delete set null,
  assignee_id              uuid references users(id) on delete set null,
  assigned_at              timestamptz,
  first_response_at        timestamptz,
  -- outcome
  resolved_at              timestamptz,
  closed_at                timestamptz,
  resolution_code          text,
  resolution_notes         text,
  close_comment            text,
  -- on hold
  hold_reason              text,
  hold_started_at          timestamptz,
  hold_until               timestamptz,
  -- SLA summary (the per-clock detail is in ticket_sla)
  sla_policy_id            uuid references sla_policies(id) on delete set null,
  sla_business_hours       boolean not null default false,
  sla_response_due         timestamptz,
  sla_resolution_due       timestamptz,
  sla_response_breached    boolean not null default false,
  sla_resolution_breached  boolean not null default false,
  -- problem
  root_cause               text,
  workaround               text,
  known_error              boolean not null default false,
  -- change
  change_type              text check (change_type is null or change_type in ('standard', 'normal', 'emergency')),
  risk                     text check (risk is null or risk in ('low', 'medium', 'high')),
  justification            text,
  implementation_plan      text,
  backout_plan             text,
  test_plan                text,
  planned_start            timestamptz,
  planned_end              timestamptz,
  actual_start             timestamptz,
  actual_end               timestamptz,
  change_outcome           text check (change_outcome is null or change_outcome in ('successful', 'partially_successful', 'failed', 'backed_out')),
  cab_group_id             uuid references groups(id) on delete set null,
  -- service request
  catalog_item_id          uuid references catalog_items(id) on delete set null,
  form_data                jsonb not null default '{}'::jsonb,
  -- extensibility
  custom                   jsonb not null default '{}'::jsonb,
  legacy                   jsonb,          -- fields kept verbatim from the old helpdesk
  version                  integer not null default 1,   -- optimistic concurrency
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  search                   tsvector generated always as (
                             to_tsvector('simple', coalesce(number, '') || ' ' || coalesce(subject, '') || ' ' || coalesce(description, ''))
                           ) stored,
  check (planned_start is null or planned_end is null or planned_end > planned_start),
  unique (tenant_id, number)
);
create index tickets_tenant_type_status_idx on tickets (tenant_id, ticket_type, status, created_at desc);
create index tickets_assignee_idx on tickets (tenant_id, assignee_id, status);
create index tickets_group_idx on tickets (tenant_id, assignment_group_id, status);
create index tickets_requester_idx on tickets (tenant_id, requester_id, created_at desc);
create index tickets_search_idx on tickets using gin (search);
create index tickets_hold_idx on tickets (hold_until) where status = 'on_hold';

-- Public replies and internal notes
create table ticket_comments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete restrict,
  ticket_id    uuid not null references tickets(id) on delete cascade,
  author_id    uuid references users(id) on delete set null,
  author_label text,                 -- email sender, system
  body         text not null,
  is_internal  boolean not null default false,
  source       text not null default 'web' check (source in ('web', 'email', 'system', 'api', 'migration')),
  created_at   timestamptz not null default now()
);
create index ticket_comments_ticket_idx on ticket_comments (ticket_id, created_at);

-- Append-only event history per ticket
create table ticket_activity (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete restrict,
  ticket_id   uuid not null references tickets(id) on delete cascade,
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index ticket_activity_ticket_idx on ticket_activity (ticket_id, created_at);

create table ticket_assignments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete restrict,
  ticket_id      uuid not null references tickets(id) on delete cascade,
  user_id        uuid references users(id) on delete set null,
  group_id       uuid references groups(id) on delete set null,
  action         text not null default 'assigned',
  assigned_by    uuid references users(id) on delete set null,
  assigned_at    timestamptz not null default now(),
  unassigned_at  timestamptz
);
create index ticket_assignments_ticket_idx on ticket_assignments (ticket_id, assigned_at);

create table ticket_links (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete restrict,
  from_ticket  uuid not null references tickets(id) on delete cascade,
  to_ticket    uuid not null references tickets(id) on delete cascade,
  link_type    text not null check (link_type in ('related', 'caused_by', 'duplicate_of', 'implements', 'parent_of')),
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (from_ticket <> to_ticket),
  unique (from_ticket, to_ticket, link_type)
);
create index ticket_links_to_idx on ticket_links (to_ticket);

create table ticket_watchers (
  ticket_id  uuid not null references tickets(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (ticket_id, user_id)
);

-- Work items inside a request or change (fulfilment steps, implementation tasks)
create table ticket_tasks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  title         text not null,
  assignee_id   uuid references users(id) on delete set null,
  group_id      uuid references groups(id) on delete set null,
  status        text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  due_at        timestamptz,
  sort_order    integer not null default 0,
  completed_at  timestamptz,
  completed_by  uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index ticket_tasks_ticket_idx on ticket_tasks (ticket_id, sort_order);

-- One row per SLA/OLA clock on a ticket
create table ticket_sla (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete restrict,
  ticket_id        uuid not null references tickets(id) on delete cascade,
  kind             text not null check (kind in ('response', 'resolution', 'ola_response', 'ola_resolution')),
  policy_id        uuid references sla_policies(id) on delete set null,
  group_id         uuid references groups(id) on delete set null,
  target_minutes   integer not null,
  business_hours   boolean not null default false,
  warn_percent     integer not null default 75,
  started_at       timestamptz not null,
  due_at           timestamptz not null,
  status           text not null default 'active' check (status in ('active', 'paused', 'met', 'breached', 'cancelled')),
  paused_at        timestamptz,
  paused_minutes   numeric not null default 0,
  stopped_at       timestamptz,
  breached         boolean not null default false,
  breached_at      timestamptz,
  warned_at        timestamptz,
  created_at       timestamptz not null default now()
);
create index ticket_sla_ticket_idx on ticket_sla (ticket_id);
create index ticket_sla_due_idx on ticket_sla (due_at) where status = 'active';

-- Approvals for changes (CAB) and service requests
create table approvals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete restrict,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  step          integer not null default 1,
  approver_id   uuid references users(id) on delete set null,
  group_id      uuid references groups(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid references users(id) on delete set null,
  decided_at    timestamptz,
  comment       text,
  requested_by  uuid references users(id) on delete set null,
  requested_at  timestamptz not null default now(),
  check (approver_id is not null or group_id is not null)
);
create index approvals_ticket_idx on approvals (ticket_id, step);
create index approvals_pending_idx on approvals (tenant_id, status) where status = 'pending';

-- Maintenance windows and change freezes (blackouts); used by changes and patch deployments
create table maintenance_windows (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  name              text not null,
  description       text,
  kind              text not null default 'maintenance' check (kind in ('maintenance', 'blackout')),
  applies_to        text not null default 'all' check (applies_to in ('all', 'changes', 'patches')),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  recurrence        text not null default 'none' check (recurrence in ('none', 'daily', 'weekly', 'monthly')),
  recurrence_until  timestamptz,
  is_active         boolean not null default true,
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index maintenance_windows_tenant_idx on maintenance_windows (tenant_id, starts_at);

-- ---------------------------------------------------------------------------
-- Knowledge base
-- ---------------------------------------------------------------------------
create table kb_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index kb_categories_name_key on kb_categories (tenant_id, lower(name));

create table kb_articles (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  number        text not null,
  title         text not null check (length(trim(title)) between 1 and 300),
  summary       text,
  body          text not null default '',      -- Markdown (rendered with a safe subset)
  category_id   uuid references kb_categories(id) on delete set null,
  status        text not null default 'draft' check (status in ('draft', 'review', 'published', 'retired')),
  visibility    text not null default 'internal' check (visibility in ('public', 'internal')),
  tags          text[] not null default array[]::text[],
  author_id     uuid references users(id) on delete set null,
  published_at  timestamptz,
  version       integer not null default 1,
  views         integer not null default 0,
  helpful_yes   integer not null default 0,
  helpful_no    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  search        tsvector generated always as (
                  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('simple', coalesce(summary, '')), 'B') ||
                  setweight(to_tsvector('simple', coalesce(body, '')), 'C')
                ) stored,
  unique (tenant_id, number)
);
create index kb_articles_search_idx on kb_articles using gin (search);
create index kb_articles_tenant_idx on kb_articles (tenant_id, status, updated_at desc);

create table kb_article_versions (
  id          uuid primary key default gen_random_uuid(),
  article_id  uuid not null references kb_articles(id) on delete cascade,
  version     integer not null,
  title       text not null,
  summary     text,
  body        text not null,
  edited_by   uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (article_id, version)
);

create table kb_article_tickets (
  article_id  uuid not null references kb_articles(id) on delete cascade,
  ticket_id   uuid not null references tickets(id) on delete cascade,
  linked_by   uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (article_id, ticket_id)
);

create table kb_votes (
  article_id  uuid not null references kb_articles(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  helpful     boolean not null,
  created_at  timestamptz not null default now(),
  primary key (article_id, user_id)
);
