-- 0434 · The outbox in daily partitions (shortcut 1, ADR-988)
-- platform.outbox_events becomes a table partitioned by the UTC day an event occurred on, so that
-- a week's events are kept and older days are dropped whole, not deleted row by row. A default
-- partition takes any event whose day has no partition yet, so an insert never fails; the worker
-- makes each day's partition a week ahead, moving into it what the default holds of that day.
-- A day's partition is dropped once the whole day is before the cut-off and it holds no event
-- unpublished or published since: an event not yet published, or parked after its attempts, is
-- kept however old, as before, the published ones around it still deleted by the retention sweep
-- (ADR-746). Its rows, policies,
-- grants, indexes and trigger are as they were. See ADR-988 in docs/architecture/13-decision-log.md.

ALTER TABLE platform.outbox_events RENAME TO outbox_events_unpartitioned;
ALTER INDEX platform.outbox_events_pkey RENAME TO outbox_events_unpartitioned_pkey;
ALTER INDEX platform.outbox_events_unpublished_idx RENAME TO outbox_events_unpartitioned_unpublished_idx;
ALTER INDEX platform.outbox_events_published_idx RENAME TO outbox_events_unpartitioned_published_idx;

-- The key holds the day too, as a partitioned table's must; an event's ID is a UUIDv7, its own.
CREATE TABLE platform.outbox_events (
  id             uuid        NOT NULL,
  shop_id        uuid        NOT NULL,
  aggregate_type text        NOT NULL,
  aggregate_id   uuid        NOT NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer     NOT NULL DEFAULT 0,
  last_error     text,
  trace_context  text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE platform.outbox_events_default PARTITION OF platform.outbox_events DEFAULT;

CREATE INDEX outbox_events_unpublished_idx
  ON platform.outbox_events (occurred_at, id)
  WHERE published_at IS NULL;
CREATE INDEX outbox_events_published_idx
  ON platform.outbox_events (published_at)
  WHERE published_at IS NOT NULL;
-- The relay marks events by their ID alone.
CREATE INDEX outbox_events_id_idx ON platform.outbox_events (id);

-- Who may write and read it, as before: through the parent alone, the partitions granted to none.
ALTER TABLE platform.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_append ON platform.outbox_events
  FOR INSERT TO hatti_app_role
  WITH CHECK (shop_id = platform.current_shop_id());
CREATE POLICY system_access ON platform.outbox_events
  TO hatti_system_role
  USING (true) WITH CHECK (true);
CREATE POLICY identity_shop_opened ON platform.outbox_events
  FOR INSERT TO hatti_identity_role
  WITH CHECK (event_type = 'shop.opened' AND aggregate_type = 'shop' AND aggregate_id = shop_id);
CREATE POLICY identity_development_store_transferred ON platform.outbox_events
  FOR INSERT TO hatti_identity_role
  WITH CHECK (event_type = 'shop.development_store_transferred' AND aggregate_type = 'shop'
              AND aggregate_id = shop_id);
CREATE POLICY identity_shop_closed ON platform.outbox_events
  FOR INSERT TO hatti_identity_role
  WITH CHECK (event_type IN ('shop.closed', 'shop.reopened') AND aggregate_type = 'shop'
              AND aggregate_id = shop_id);
GRANT INSERT ON platform.outbox_events TO hatti_app_role;
GRANT INSERT ON platform.outbox_events TO hatti_identity_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.outbox_events TO hatti_system_role;

CREATE TRIGGER outbox_events_notify
  AFTER INSERT ON platform.outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_outbox();

-- Makes the partitions of the UTC days from `from_day` for `days` days that have none, each
-- taking from the default partition what it holds of its day; says how many it made.
CREATE FUNCTION platform.outbox_make_partitions(from_day date, days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, platform
AS $$
DECLARE
  day date;
  name text;
  made integer := 0;
BEGIN
  IF days < 1 OR days > 60 THEN
    RAISE EXCEPTION 'outbox partitions are made 1 to 60 days at a time';
  END IF;
  FOR i IN 0 .. days - 1 LOOP
    day := from_day + i;
    name := 'outbox_events_p' || to_char(day, 'YYYYMMDD');
    CONTINUE WHEN to_regclass('platform.' || name) IS NOT NULL;
    EXECUTE format(
      'CREATE TABLE platform.%I (LIKE platform.outbox_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
      name);
    -- What the default took of the day while it had no partition, moved into it first.
    EXECUTE format(
      'WITH moved AS (DELETE FROM platform.outbox_events_default
                       WHERE occurred_at >= %L::timestamptz AND occurred_at < %L::timestamptz
                       RETURNING *)
       INSERT INTO platform.%I SELECT * FROM moved',
      day::timestamp AT TIME ZONE 'UTC', (day + 1)::timestamp AT TIME ZONE 'UTC', name);
    EXECUTE format(
      'ALTER TABLE platform.outbox_events ATTACH PARTITION platform.%I
         FOR VALUES FROM (%L) TO (%L)',
      name, day::timestamp AT TIME ZONE 'UTC', (day + 1)::timestamp AT TIME ZONE 'UTC');
    made := made + 1;
  END LOOP;
  RETURN made;
END
$$;

-- Drops the partitions of the UTC days ended by `cut_off` that hold no event unpublished or
-- published since; says how many it dropped. A day with one waiting or parked is kept, for the
-- sweep to empty of the rest.
CREATE FUNCTION platform.outbox_drop_partitions(cut_off timestamptz) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, platform
AS $$
DECLARE
  part record;
  waiting boolean;
  dropped integer := 0;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.inhparent = 'platform.outbox_events'::regclass
       AND n.nspname = 'platform'
       AND c.relname ~ '^outbox_events_p[0-9]{8}$'
       AND (to_date(substr(c.relname, 16), 'YYYYMMDD') + 1)::timestamp AT TIME ZONE 'UTC'
           <= cut_off
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM platform.%I
                                    WHERE published_at IS NULL OR published_at >= %L)',
                   part.relname, cut_off) INTO waiting;
    CONTINUE WHEN waiting;
    EXECUTE format('DROP TABLE platform.%I', part.relname);
    dropped := dropped + 1;
  END LOOP;
  RETURN dropped;
END
$$;

REVOKE ALL ON FUNCTION platform.outbox_make_partitions(date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.outbox_drop_partitions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.outbox_make_partitions(date, integer) TO hatti_system_role;
GRANT EXECUTE ON FUNCTION platform.outbox_drop_partitions(timestamptz) TO hatti_system_role;

-- The days around now made, then the events moved across, each into its day's partition, those
-- older than the week before into the default, for the sweep to delete once published.
SELECT platform.outbox_make_partitions((now() AT TIME ZONE 'UTC')::date - 8, 16);
INSERT INTO platform.outbox_events SELECT * FROM platform.outbox_events_unpartitioned;
DROP TABLE platform.outbox_events_unpartitioned;
