-- =============================================================================
-- 0005 CMDB extras.
-- 1. ci_history outlives the item it describes: deleting a CI writes a final
--    "deleted" history row (with the field values it had), which the cascading
--    foreign key would otherwise remove at once. Rows stay tenant-scoped.
-- 2. Serial-number lookups (agent inventory matches devices to CIs by serial
--    before host name) get an index.
-- =============================================================================

alter table ci_history drop constraint if exists ci_history_ci_id_fkey;

create index if not exists configuration_items_serial_idx
  on configuration_items (tenant_id, upper(trim(serial_no)))
  where serial_no is not null;
