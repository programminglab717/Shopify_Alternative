-- 0010 · Segments
-- Saved customer filters, e.g. "Lahore · bought 2+ times · no order in 60 days". A segment keeps
-- its query, not its members: members are found when asked for, so they are always current.
-- See docs/architecture/07-messaging-and-marketing.md §5.1 and docs/engineering/conventions.md.

CREATE TABLE customers.segments (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  -- In the segment query language; checked when saved.
  query      text        NOT NULL CHECK (length(query) BETWEEN 1 AND 5000),
  version    integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

-- Names are unique per shop, ignoring case.
CREATE UNIQUE INDEX segments_name_key ON customers.segments (shop_id, lower(name));

SELECT platform.enable_tenant_isolation('customers.segments');
