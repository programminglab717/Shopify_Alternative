-- 0429 · Drafts taken out of a running theme experiment
-- A shop may take a draft out of its running experiment (OS-22): its arm is stopped as Hatti
-- stops one that sells clearly worse (ADR-939), its shoppers shown the live theme and its counts
-- kept as they were, and is named here too, so the admin says the shop took it out. A draft added
-- to a running experiment needs nothing new: it is the next arm. See ADR-970 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE online_store.theme_experiments
  ADD COLUMN taken_out_arms text[] NOT NULL DEFAULT '{}'
    CHECK (taken_out_arms <@ stopped_arms);
