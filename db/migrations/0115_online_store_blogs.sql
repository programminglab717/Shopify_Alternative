-- 0115 · Blogs
-- A shop's blogs, such as News, which its storefront shows at /blogs/{handle}, and their articles,
-- at /blogs/{handle}/{article} (OS-07), as Shopify's: an article has a title, a body and a summary
-- of HTML, cleaned when saved as pages' bodies are, its author's name, tags, and when it was
-- published. Deleting a blog deletes its articles. See ADR-176 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE online_store.blogs (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  handle          text        NOT NULL CHECK (handle ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'),
  title           text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  -- Another of the theme's blog templates, "news" for blog.news.json; null for blog.json.
  template_suffix text        CHECK (template_suffix ~ '^[a-z0-9_-]{1,50}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, handle)
);

CREATE TABLE online_store.articles (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  blog_id         uuid        NOT NULL,
  -- Unique in its blog: /blogs/news/{handle}.
  handle          text        NOT NULL CHECK (handle ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'),
  title           text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  body            text        NOT NULL DEFAULT '' CHECK (octet_length(body) <= 524288),
  -- What the blog's page shows of it; empty for none, when themes show the body's beginning.
  summary         text        NOT NULL DEFAULT '' CHECK (octet_length(summary) <= 65536),
  -- The name it is signed with; empty for none.
  author          text        NOT NULL DEFAULT '' CHECK (length(author) <= 255),
  tags            text[]      NOT NULL DEFAULT '{}',
  -- Shown on the storefront since then; null for an article kept hidden, as while it is written.
  published_at    timestamptz,
  -- Another of the theme's article templates, "recipe" for article.recipe.json; null for
  -- article.json.
  template_suffix text        CHECK (template_suffix ~ '^[a-z0-9_-]{1,50}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, blog_id, handle),
  FOREIGN KEY (shop_id, blog_id) REFERENCES online_store.blogs (shop_id, id) ON DELETE CASCADE
);

-- A blog's articles, the latest published first, as its page lists them.
CREATE INDEX articles_blog_published_idx
  ON online_store.articles (shop_id, blog_id, published_at DESC, id DESC);

SELECT platform.enable_tenant_isolation('online_store.blogs');
SELECT platform.enable_tenant_isolation('online_store.articles');
