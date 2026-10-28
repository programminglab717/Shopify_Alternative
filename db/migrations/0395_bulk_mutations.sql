-- 0395 · Bulk mutations (DEV-10)
-- A bulk operation may run a mutation once for each line of a JSONL file of variables the caller
-- staged, writing each answer to a JSONL file (ADR-897). One query and one mutation run at a time
-- for a caller, as Shopify's.
-- See ADR-897 in docs/architecture/13-decision-log.md.

ALTER TABLE apps.bulk_operations
  ADD COLUMN type text NOT NULL DEFAULT 'query' CHECK (type IN ('query', 'mutation')),
  -- Where a mutation's variables were staged; the file is removed once they have run.
  ADD COLUMN variables_key text CHECK (char_length(variables_key) <= 300),
  ADD CHECK ((type = 'mutation') = (variables_key IS NOT NULL));

DROP INDEX apps.bulk_operations_one_running;
CREATE UNIQUE INDEX bulk_operations_one_running ON apps.bulk_operations (shop_id, caller, type)
  WHERE status = 'running';
