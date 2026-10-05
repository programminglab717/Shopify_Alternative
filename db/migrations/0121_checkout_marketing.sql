-- 0121 · Marketing consent at checkout (CUS-04)
-- The channels a shop's checkout offers boxes for its news and offers on: WhatsApp, SMS and
-- email, each unticked until the shopper ticks it. A box ticked records the customer's consent on
-- its channel as the order is placed, with the page's words, from the checkout. A shop without a
-- row offers WhatsApp alone; an empty list offers none.
-- See ADR-187 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.marketing_options (
  shop_id    uuid        PRIMARY KEY,
  -- Each once, in the order the page shows them: whatsapp, sms, email.
  channels   text[]      NOT NULL DEFAULT '{}'
                         CHECK (channels <@ ARRAY['whatsapp', 'sms', 'email']
                                AND cardinality(channels) <= 3),
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('checkout.marketing_options');
