-- 0423 · A share of its own for each of a theme experiment's drafts (OS-22)
-- An experiment of several drafts (ADR-931) showed each the same share of shoppers. Each may now
-- have its own: `share` stays the first draft's, arm b; `other_shares` are the others', in the
-- order of `other_theme_ids`, or none for each the same as the first. The live theme is shown to
-- no fewer shoppers than any draft, as the service checks. See ADR-952 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.theme_experiments
  ADD COLUMN other_shares smallint[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(other_shares) IN (0, cardinality(other_theme_ids))
           AND 1 <= ALL (other_shares) AND 50 >= ALL (other_shares));

-- The shares no longer one for every draft: what each may be is checked as an experiment starts.
DO $$
DECLARE
  name text;
BEGIN
  FOR name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'online_store.theme_experiments'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%cardinality(other_theme_ids) + 2%'
  LOOP
    EXECUTE format('ALTER TABLE online_store.theme_experiments DROP CONSTRAINT %I', name);
  END LOOP;
END $$;
