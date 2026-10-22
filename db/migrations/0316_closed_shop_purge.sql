-- 0316 · A closed shop's data deleted
-- 90 days after its owner closed it (ADR-740), a shop's data is deleted, except the records the
-- law has Hatti keep, such as tax records (Hatti's terms, ADR-736): the worker's sweep or Hatti's
-- people do it, and `purged_at` says it is done (ADR-741). Its row stays, closed, for what is
-- kept to name.

ALTER TABLE control.shops ADD COLUMN purged_at timestamptz;
ALTER TABLE control.shops ADD CONSTRAINT shops_purged
  CHECK (purged_at IS NULL OR status = 'closed');
-- Never reopened once its data is gone, nor changed at all by identity: restrictive, so no
-- permissive policy, such as a development store's going to its client (0235), lets it.
DROP POLICY identity_status ON control.shops;
CREATE POLICY identity_status ON control.shops
  AS RESTRICTIVE FOR UPDATE TO hatti_identity_role
  USING (purged_at IS NULL) WITH CHECK (status IN ('active', 'closed'));
