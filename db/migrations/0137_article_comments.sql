-- 0137 · Comments on articles
-- A blog takes comments on its articles as its policy says, as Shopify's commentPolicy: none
-- (closed, as a new blog is), each held for the shop to approve (moderated), or each shown at once
-- (auto_published). Shoppers post them from an article's page on the storefront; the shop
-- approves them, marks them as spam or deletes them through the Admin API. Deleting an article
-- deletes its comments. See ADR-220 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.blogs
  ADD COLUMN comment_policy text NOT NULL DEFAULT 'closed'
    CHECK (comment_policy IN ('closed', 'moderated', 'auto_published'));

CREATE TABLE online_store.comments (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL DEFAULT platform.uuidv7(),
  article_id   uuid        NOT NULL,
  -- The name it is signed with, and the address the shop may answer at: the storefront shows
  -- the name alone.
  author       text        NOT NULL CHECK (length(author) BETWEEN 1 AND 255),
  email        text        NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  -- Plain text, as typed: the storefront escapes it.
  body         text        NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  -- pending until the shop approves it, where the blog moderates; published once shown.
  status       text        NOT NULL CHECK (status IN ('pending', 'published', 'spam')),
  -- Where it was posted from, for the shop to tell spam: the shopper's address and browser.
  ip           inet,
  user_agent   text        CHECK (length(user_agent) <= 512),
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, article_id) REFERENCES online_store.articles (shop_id, id) ON DELETE CASCADE
);

-- An article's comments, by status, oldest first, as its page and documents show them.
CREATE INDEX comments_article_idx ON online_store.comments (shop_id, article_id, status, id);
-- The shop's comments, the latest first, by status, as the admin lists those to approve.
CREATE INDEX comments_status_idx ON online_store.comments (shop_id, status, id DESC);

SELECT platform.enable_tenant_isolation('online_store.comments');
