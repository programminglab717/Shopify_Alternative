-- 0164 · Translations go with what they translate
-- A translation names what it translates by its ID alone, any of the catalog's products,
-- collections, options and their values, or the online store's pages, blogs, articles, menus,
-- menu items and policies (ADR-238), so no foreign key can delete it with that. These triggers do,
-- as one would, whichever way it goes: alone, with its product, blog or menu, or a menu's item
-- dropped from it. Translations of what went before this go now (OS-06). See ADR-261 in
-- docs/architecture/13-decision-log.md.

-- The translations of the rows a statement deleted, by their IDs.
CREATE FUNCTION online_store.forget_translations() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM online_store.translations t
   USING gone
   WHERE t.shop_id = gone.shop_id AND t.resource_id = gone.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON catalog.products
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON catalog.collections
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON catalog.product_options
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON catalog.product_option_values
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON online_store.pages
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON online_store.blogs
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON online_store.articles
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON online_store.policies
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_translations();

-- A menu's items are a tree in its row, each with an ID of its own: they go with the menu, or as
-- an update drops them from it. Compared as text, so an ID that is no UUID fails nothing.
CREATE FUNCTION online_store.forget_menu_translations() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM online_store.translations t
   USING (SELECT shop_id, id::text AS id FROM gone
          UNION ALL
          SELECT shop_id, item #>> '{}'
            FROM gone, jsonb_path_query(items, 'strict $.**.id') AS item) AS g
   WHERE t.shop_id = g.shop_id AND t.resource_id::text = g.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER translations_forgotten
  AFTER DELETE ON online_store.menus
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_menu_translations();

CREATE FUNCTION online_store.forget_menu_item_translations() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM online_store.translations t
   USING (SELECT shop_id, item #>> '{}' AS id
            FROM old_menus, jsonb_path_query(items, 'strict $.**.id') AS item
          EXCEPT
          SELECT shop_id, item #>> '{}'
            FROM new_menus, jsonb_path_query(items, 'strict $.**.id') AS item) AS g
   WHERE t.shop_id = g.shop_id AND t.resource_id::text = g.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER item_translations_forgotten
  AFTER UPDATE ON online_store.menus
  REFERENCING OLD TABLE AS old_menus NEW TABLE AS new_menus
  FOR EACH STATEMENT EXECUTE FUNCTION online_store.forget_menu_item_translations();

-- Translations of what was deleted before this. The shop's own, of its home page (ADR-245), are
-- by its own ID.
DELETE FROM online_store.translations t
 WHERE t.resource_id <> t.shop_id
   AND NOT EXISTS (SELECT FROM catalog.products x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM catalog.collections x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM catalog.product_options x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM catalog.product_option_values x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM online_store.pages x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM online_store.blogs x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM online_store.articles x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM online_store.policies x
                    WHERE x.shop_id = t.shop_id AND x.id = t.resource_id)
   AND NOT EXISTS (SELECT FROM online_store.menus x
                    WHERE x.shop_id = t.shop_id
                      AND (x.id = t.resource_id
                           OR jsonb_path_exists(x.items, 'strict $.**.id ? (@ == $id)',
                                                jsonb_build_object('id', t.resource_id::text))));
