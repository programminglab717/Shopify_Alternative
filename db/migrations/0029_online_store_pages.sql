-- 0029 · Online store pages
-- A shop's own pages, such as About us, Contact, and how it delivers and takes returns, which its
-- storefront shows at /pages/{handle} and its menus link to. A body is HTML, kept as it was
-- cleaned when saved: text and its formatting, links, images and tables, nothing that runs. See
-- ADR-045 in docs/architecture/13-decision-log.md.

CREATE TABLE online_store.pages (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  handle          text        NOT NULL CHECK (handle ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'),
  title           text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  body            text        NOT NULL DEFAULT '' CHECK (octet_length(body) <= 524288),
  -- Shown on the storefront since then; null for a page kept hidden, as while it is written.
  published_at    timestamptz,
  -- Another of the theme's page templates, "contact" for page.contact.json; null for page.json.
  template_suffix text        CHECK (template_suffix ~ '^[a-z0-9_-]{1,50}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, handle)
);

SELECT platform.enable_tenant_isolation('online_store.pages');
