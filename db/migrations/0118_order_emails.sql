-- 0118 · Order emails to customers
-- A shop's message about an order goes by email too (MSG-01), to the address its customer gave
-- with it at checkout, beside its WhatsApp message or SMS: the same news, from Hatti's address
-- under the shop's name. An email's recipient is that address, lowercased; every other channel's
-- is a number in E.164.
-- See ADR-181 in docs/architecture/13-decision-log.md.

ALTER TABLE messaging.messages
  DROP CONSTRAINT messages_channel_check,
  DROP CONSTRAINT messages_recipient_check,
  ADD CONSTRAINT messages_channel_check CHECK (channel IN ('whatsapp', 'sms', 'email')),
  ADD CONSTRAINT messages_recipient_check CHECK (
    CASE WHEN channel = 'email'
         THEN char_length(recipient) <= 254
              AND recipient = lower(recipient)
              AND recipient ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
         ELSE recipient ~ '^\+[1-9][0-9]{6,14}$'
    END);
