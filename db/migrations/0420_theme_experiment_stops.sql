-- 0420 · A theme experiment's draft stopped alone (OS-22)
-- Of an experiment of several drafts (ADR-931), one that sells clearly worse is stopped alone:
-- its shoppers are shown the live theme from then, and the others go on. The experiment ends as
-- before once every draft is stopped. See ADR-939 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.theme_experiments
  ADD COLUMN stopped_arms text[] NOT NULL DEFAULT '{}'
    CHECK (stopped_arms <@ ARRAY['b', 'c', 'd']::text[]);
