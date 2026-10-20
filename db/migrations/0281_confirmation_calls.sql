-- 0281 · Confirmation calls
-- Where the shop says so, a cash-on-delivery order whose customer has not answered the reminder
-- to confirm it is called once, in calling hours, by an automated call in Urdu: pressing 1
-- confirms it, and 2 cancels it (COD-03). The call is a message on a channel of its own, voice,
-- paid from the shop's message credit as WhatsApp's and SMS are.
-- See ADR-611 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.messages
  DROP CONSTRAINT messages_channel_check,
  ADD CONSTRAINT messages_channel_check CHECK (channel IN ('whatsapp', 'sms', 'email', 'voice'));

ALTER TABLE billing.wallet_entries
  DROP CONSTRAINT wallet_entries_channel_check,
  ADD CONSTRAINT wallet_entries_channel_check CHECK (channel IN ('whatsapp', 'sms', 'voice'));

-- off; high_value, the orders the shop's risk settings count as of high value; or all.
ALTER TABLE orders.order_settings
  ADD COLUMN confirmation_calls text NOT NULL DEFAULT 'off'
    CHECK (confirmation_calls IN ('off', 'high_value', 'all'));

-- When the order's customer was called to confirm it: once, at most.
ALTER TABLE orders.orders ADD COLUMN confirmation_called_at timestamptz;
