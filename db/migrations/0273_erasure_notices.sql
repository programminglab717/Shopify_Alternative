-- 0273 · Erasure notices
-- A shopper who asks for their erasure from their account (ADR-572) is told when it is done
-- (CUS-05, ADR-582): the request keeps the number their sign-in proved and the language of the
-- page they asked from, to tell them at once in. Both go with the request, and so with the
-- customer, when the erasure is carried out; the message telling them is forgotten once sent.
-- Null for a request staff or an app made, of which no one is told.
-- See ADR-582 in docs/architecture/13-decision-log.md.

ALTER TABLE customers.erasure_requests
  ADD COLUMN notify_phone    text CHECK (notify_phone ~ '^\+[1-9][0-9]{6,14}$'),
  ADD COLUMN notify_language text CHECK (notify_language IN ('en', 'ur')),
  ADD CONSTRAINT erasure_requests_notify_check
    CHECK ((notify_phone IS NULL) = (notify_language IS NULL));
