-- 0133 · Searching a shop's articles and pages
-- A storefront's search finds a shop's published articles and pages beside its products (ADR-212):
-- each keeps the words a search looks for, folded as products' are, from its title, for an
-- article its tags and author, and the opening of its text. Those kept before this get theirs in
-- lowercase with spaces for markup and punctuation, unfolded; each is folded when it next changes.
-- A shop's articles and pages are few, so a search reads them all, as it reads its products.

ALTER TABLE online_store.pages ADD COLUMN search_text text NOT NULL DEFAULT '';
ALTER TABLE online_store.articles ADD COLUMN search_text text NOT NULL DEFAULT '';

UPDATE online_store.pages
   SET search_text = btrim(regexp_replace(
         lower(concat_ws(' ', title, left(regexp_replace(body, '<[^>]*>', ' ', 'g'), 10000))),
         '[[:space:][:punct:]]+', ' ', 'g'));

UPDATE online_store.articles
   SET search_text = btrim(regexp_replace(
         lower(concat_ws(' ', title, array_to_string(tags, ' '), author,
                         left(regexp_replace(summary || ' ' || body, '<[^>]*>', ' ', 'g'), 10000))),
         '[[:space:][:punct:]]+', ' ', 'g'));
