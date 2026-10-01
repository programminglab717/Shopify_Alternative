-- 0058 · What a return cost
-- A parcel keeps what couriers' statements charged for it, both ways (COD-09): the charges on
-- each line of its statements as they are imported (COD-10), which COD health adds up for the
-- parcels that came back. Statements imported before charge their parcels here, as an import now
-- would have. A statement is imported once: one with the same lines as one imported before is
-- refused, as one with the same reference is. See ADR-088 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.fulfillments
  -- Minor units; null while no statement has charged it.
  ADD COLUMN courier_charges bigint CHECK (courier_charges >= 0);

-- Lines for cash collected before are left out: their charges came with the cash.
UPDATE orders.fulfillments f
   SET courier_charges = c.charges
  FROM (SELECT shop_id, fulfillment_id, sum(charges) AS charges
          FROM logistics.cod_remittance_lines
         WHERE fulfillment_id IS NOT NULL AND charges > 0
           AND NOT (outcome = 'repeated' AND collected > 0)
         GROUP BY shop_id, fulfillment_id) c
 WHERE f.shop_id = c.shop_id AND f.id = c.fulfillment_id;

ALTER TABLE logistics.cod_remittances
  -- SHA-256 of its lines as read, in any order: the same statement, however it was saved, has
  -- the same one. Null for statements imported before.
  ADD COLUMN digest bytea CHECK (octet_length(digest) = 32);

CREATE INDEX cod_remittances_digest_idx ON logistics.cod_remittances (shop_id, digest)
  WHERE digest IS NOT NULL;
