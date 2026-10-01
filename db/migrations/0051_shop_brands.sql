-- 0051 · The shop's brand
-- A shop's logo is one of its files (ADR-081), as Shopify's shop.brand.logo is one of its
-- images: the checkout's page shows it in place of the shop's name (CHK-14). A row for each shop
-- that chose one; deleting the file takes the logo with it. See ADR-081 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE files.brands (
  shop_id      uuid        NOT NULL PRIMARY KEY,
  -- One of the shop's files, an image; null once there is none.
  logo_file_id uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, logo_file_id) REFERENCES files.files (shop_id, id)
    ON DELETE SET NULL (logo_file_id)
);

SELECT platform.enable_tenant_isolation('files.brands');
