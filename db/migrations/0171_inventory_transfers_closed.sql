-- 0171 · Transfers closed with what arrived
-- Stock lost on the way between locations (INV-04): a transfer is closed with what arrived, and
-- what had not is lost, not put back where it left, as cancelling would. It left on hand where it
-- was sent from; nothing more changes in stock. See ADR-366 in docs/architecture/13-decision-log.md.

ALTER TABLE inventory.transfers
  DROP CONSTRAINT transfers_status_check,
  ADD CONSTRAINT transfers_status_check
    CHECK (status IN ('in_transit', 'received', 'cancelled', 'closed'));
