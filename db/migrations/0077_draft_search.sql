-- 0077 · Searching drafts
-- A draft keeps the words a search of the drafts looks for, folded as the orders' are: its
-- customer's name, city and email (ADR-123). Drafts kept before this get theirs in lowercase with
-- spaces for punctuation, unfolded; each is folded when it next changes. A shop's drafts are few,
-- so a search reads them all, as a storefront's search reads its products.

ALTER TABLE orders.draft_orders ADD COLUMN search_text text NOT NULL DEFAULT '';

UPDATE orders.draft_orders
   SET search_text = btrim(regexp_replace(
         lower(concat_ws(' ', shipping_address->>'name', shipping_address->>'city', email)),
         '[[:space:][:punct:]]+', ' ', 'g'));
