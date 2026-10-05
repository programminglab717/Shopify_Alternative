-- 0129 · The link page's taps
-- Each day's taps on the links of a shop's link-in-bio page (CH-07), in the shop's time zone, by
-- where each link goes: the shop's own links and its chat on WhatsApp. Storefronts count them in
-- Valkey as shoppers tap; the worker keeps each day's counts so far here, every minute, as it
-- keeps the sessions (ADR-180). A link is keyed by the SHA-256 of its address, which may be long.
-- See ADR-204 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.link_taps (
  shop_id    uuid        NOT NULL,
  -- In the shop's time zone.
  day        date        NOT NULL,
  -- SHA-256 of url, in hex.
  link       text        NOT NULL CHECK (link ~ '^[0-9a-f]{64}$'),
  -- A path on the storefront, or an https address.
  url        text        NOT NULL CHECK (url <> ''),
  taps       integer     NOT NULL CHECK (taps >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, day, link)
);

SELECT platform.enable_tenant_isolation('online_store.link_taps');
