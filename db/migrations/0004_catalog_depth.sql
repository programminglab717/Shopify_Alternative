-- 0004 · Catalog depth
-- Product options and their values, variants named by option values, variant cost and weight,
-- product media, and collections (manual and rule-based). See docs/engineering/conventions.md.

-- ---------------------------------------------------------------------------------------------
-- Options: up to three per product (Size, Colour, Fabric), each with ordered values. A variant is
-- one combination of values. Positions are unique per parent but deferrable, so a reorder can
-- rewrite them in one statement.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE catalog.product_options (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  product_id uuid        NOT NULL,
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  position   smallint    NOT NULL CHECK (position BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  -- Target of composite foreign keys that also pin the product.
  CONSTRAINT product_options_product_key UNIQUE (shop_id, product_id, id),
  CONSTRAINT product_options_position_key UNIQUE (shop_id, product_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX product_options_name_key
  ON catalog.product_options (shop_id, product_id, lower(name));

SELECT platform.enable_tenant_isolation('catalog.product_options');

CREATE TABLE catalog.product_option_values (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  product_id uuid        NOT NULL,
  option_id  uuid        NOT NULL,
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  position   integer     NOT NULL CHECK (position >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT product_option_values_product_key UNIQUE (shop_id, product_id, id),
  CONSTRAINT product_option_values_position_key UNIQUE (shop_id, option_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (shop_id, product_id, option_id)
    REFERENCES catalog.product_options (shop_id, product_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX product_option_values_name_key
  ON catalog.product_option_values (shop_id, option_id, lower(name));

SELECT platform.enable_tenant_isolation('catalog.product_option_values');

-- ---------------------------------------------------------------------------------------------
-- Media: images now, video later. Files are fetched and resized by a worker (not built yet); until
-- then a media item points at its original source.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE catalog.product_media (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  product_id  uuid        NOT NULL,
  media_type  text        NOT NULL DEFAULT 'image' CHECK (media_type IN ('image')),
  source_url  text        NOT NULL CHECK (source_url ~ '^https://' AND length(source_url) <= 2048),
  alt         text        NOT NULL DEFAULT '' CHECK (length(alt) <= 512),
  position    integer     NOT NULL CHECK (position >= 1),
  status      text        NOT NULL DEFAULT 'uploaded'
                          CHECK (status IN ('uploaded', 'processing', 'ready', 'failed')),
  width       integer     CHECK (width > 0),
  height      integer     CHECK (height > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT product_media_product_key UNIQUE (shop_id, product_id, id),
  CONSTRAINT product_media_position_key UNIQUE (shop_id, product_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('catalog.product_media');

-- ---------------------------------------------------------------------------------------------
-- Variants: option values (option1 is the value of the option at position 1, and so on), unit
-- cost for profit reports, weight for shipping rates, and an image. The foreign keys include the
-- product, so a variant can only use its own product's values and media.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE catalog.variants
  ADD COLUMN option1_value_id uuid,
  ADD COLUMN option2_value_id uuid,
  ADD COLUMN option3_value_id uuid,
  -- Minor units in the shop currency, like price.
  ADD COLUMN cost             bigint  CHECK (cost >= 0),
  ADD COLUMN weight_grams     integer CHECK (weight_grams >= 0),
  ADD COLUMN media_id         uuid,
  ADD CONSTRAINT variants_option1_fkey FOREIGN KEY (shop_id, product_id, option1_value_id)
    REFERENCES catalog.product_option_values (shop_id, product_id, id),
  ADD CONSTRAINT variants_option2_fkey FOREIGN KEY (shop_id, product_id, option2_value_id)
    REFERENCES catalog.product_option_values (shop_id, product_id, id),
  ADD CONSTRAINT variants_option3_fkey FOREIGN KEY (shop_id, product_id, option3_value_id)
    REFERENCES catalog.product_option_values (shop_id, product_id, id),
  ADD CONSTRAINT variants_media_fkey FOREIGN KEY (shop_id, product_id, media_id)
    REFERENCES catalog.product_media (shop_id, product_id, id) ON DELETE SET NULL (media_id);

-- Products created before options existed may have several variants told apart only by title.
-- Give each such product a "Title" option whose values are those titles, as Shopify does, so the
-- uniqueness rule below holds. Duplicate titles get their position appended.
WITH multi AS (
  SELECT shop_id, product_id
    FROM catalog.variants
   GROUP BY shop_id, product_id
  HAVING count(*) > 1
),
options AS (
  INSERT INTO catalog.product_options (shop_id, product_id, name, position)
  SELECT shop_id, product_id, 'Title', 1 FROM multi
  RETURNING shop_id, id, product_id
),
named AS (
  SELECT v.shop_id, v.id AS variant_id, o.id AS option_id, v.product_id,
         CASE WHEN count(*) OVER (PARTITION BY v.shop_id, v.product_id, lower(v.title)) > 1
              THEN v.title || ' ' || v.position
              ELSE v.title END AS value_name,
         row_number() OVER (PARTITION BY v.shop_id, v.product_id ORDER BY v.position, v.id) AS rank
    FROM catalog.variants v
    JOIN options o ON o.shop_id = v.shop_id AND o.product_id = v.product_id
),
option_values AS (
  INSERT INTO catalog.product_option_values (shop_id, product_id, option_id, name, position)
  SELECT shop_id, product_id, option_id, value_name, rank FROM named
  RETURNING shop_id, id, option_id, name
)
UPDATE catalog.variants v
   SET option1_value_id = ov.id
  FROM named n
  JOIN option_values ov
    ON ov.shop_id = n.shop_id AND ov.option_id = n.option_id AND ov.name = n.value_name
 WHERE v.shop_id = n.shop_id AND v.id = n.variant_id;

-- One variant per combination of values. NULLS NOT DISTINCT: a product without options has
-- exactly one variant. Deferrable, so one statement can swap two variants' combinations or
-- rearrange every variant's columns when options move.
ALTER TABLE catalog.variants
  ADD CONSTRAINT variants_option_values_key
  UNIQUE NULLS NOT DISTINCT
    (shop_id, product_id, option1_value_id, option2_value_id, option3_value_id)
  DEFERRABLE INITIALLY IMMEDIATE;

-- ---------------------------------------------------------------------------------------------
-- Collections. Manual collections list the products merchants add. Smart collections have rules
-- (all or any must match) and their membership is kept up to date in the same transaction as
-- every product change, so both kinds are read the same way.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE catalog.collections (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  title        text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  handle       text        NOT NULL
                           CHECK (handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(handle) <= 255),
  description  text        NOT NULL DEFAULT '',
  sort_order   text        NOT NULL DEFAULT 'manual'
                           CHECK (sort_order IN ('manual', 'alpha_asc', 'alpha_desc', 'price_asc',
                                                 'price_desc', 'created', 'created_desc')),
  -- NULL for a manual collection; for a smart one, [{"column", "relation", "condition"}, …].
  rules        jsonb       CHECK (rules IS NULL OR jsonb_typeof(rules) = 'array'),
  disjunctive  boolean     NOT NULL DEFAULT false,
  search_text  text        NOT NULL DEFAULT '',
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT collections_shop_handle_key UNIQUE (shop_id, handle)
);

SELECT platform.enable_tenant_isolation('catalog.collections');

CREATE TABLE catalog.collection_products (
  shop_id       uuid        NOT NULL,
  collection_id uuid        NOT NULL,
  product_id    uuid        NOT NULL,
  -- Merchant order in manual collections; smart collections sort by product fields instead.
  position      integer     NOT NULL DEFAULT 1 CHECK (position >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, collection_id, product_id),
  FOREIGN KEY (shop_id, collection_id) REFERENCES catalog.collections (shop_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX collection_products_position_idx
  ON catalog.collection_products (shop_id, collection_id, position, product_id);
CREATE INDEX collection_products_product_idx
  ON catalog.collection_products (shop_id, product_id);

SELECT platform.enable_tenant_isolation('catalog.collection_products');
