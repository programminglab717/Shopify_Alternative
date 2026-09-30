-- 0024 · Online store menus
-- A shop's navigation: menus of links to its home page, all its products, a collection, a product
-- or an address, up to three levels deep. Every shop has a main menu and a footer menu, made the
-- first time it looks at its menus from what its storefront showed until then. See ADR-040 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE online_store.menus (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  handle     text        NOT NULL CHECK (handle ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'),
  title      text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  -- main-menu and footer: they keep their handles, and are not deleted.
  is_default boolean     NOT NULL DEFAULT false,
  -- Its items, a tree edited whole: [{id, title, type, resourceId, url, items}]. Links to
  -- collections and products name them by ID, and take their handles when published.
  items      jsonb       NOT NULL DEFAULT '[]'
                         CHECK (jsonb_typeof(items) = 'array' AND octet_length(items::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, handle)
);

SELECT platform.enable_tenant_isolation('online_store.menus');
