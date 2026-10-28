-- 0393 · FBR's fields on inventory items (CAT-19)
-- Beside its HS code (ADR-557), an item keeps the unit of measure FBR's digital invoicing names
-- it in, and the SRO schedule and serial number of a reduced rate or exemption it is sold under;
-- an invoice's items carry them to FBR (ADR-895). Null for FBR's default unit and no SRO.
-- See ADR-895 in docs/architecture/13-decision-log.md.

ALTER TABLE inventory.items
  ADD COLUMN fbr_unit text CHECK (char_length(fbr_unit) BETWEEN 1 AND 40),
  ADD COLUMN sro_schedule_no text CHECK (char_length(sro_schedule_no) BETWEEN 1 AND 50),
  -- A serial is of a schedule's: none without one.
  ADD COLUMN sro_item_serial_no text
    CHECK (sro_item_serial_no IS NULL
           OR (char_length(sro_item_serial_no) BETWEEN 1 AND 20 AND sro_schedule_no IS NOT NULL));
