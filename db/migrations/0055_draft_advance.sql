-- 0055 · Drafts asking for an advance
-- A cash-on-delivery draft may ask for an advance as an order does (CHK-10): its link's page says
-- what to transfer ahead, and the order its customer confirms waits for it, the link then taking
-- the receipt. See ADR-085 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.draft_orders
  -- Minor units; zero for none. Not beside an advance paid already.
  ADD COLUMN advance_due bigint NOT NULL DEFAULT 0 CHECK (advance_due >= 0),
  ADD CONSTRAINT draft_orders_advance_due_method_check
      CHECK (advance_due = 0
             OR (payment_method = 'cash_on_delivery' AND advance_paid = 0
                 AND advance_due <= total));
