import {
  ArticleUpdateMutation,
  BlogUpdateMutation,
  CollectionUpdateMutation,
  PageUpdateMutation,
} from '../api/operations';
import type { UserError } from '../api/types';
import { useAdminMutation } from '../shell/shop-context';
import { SearchListingCard, type SeoValue } from './search-listing';

/** What an update gives back: its one payload, with what was wrong. */
type Updated = Record<string, { userErrors: UserError[] }>;

type Seo = { title: string; description: string };

const NONE: SeoValue = { title: null, description: null };

/** The first thing wrong with an update, or null once it is saved. */
function wrongOf(updated: Updated): string | null {
  return Object.values(updated)[0]?.userErrors[0]?.message ?? null;
}

interface Listed {
  id: string;
  title: string;
  handle: string;
  seo?: SeoValue;
}

/**
 * A collection's search engine listing (OS-09, ADR-601): blank, its title and the start of its
 * description.
 */
export function CollectionSearchListing({
  collection,
  storefront,
}: {
  collection: Listed & { description: string };
  storefront: string;
}) {
  const update = useAdminMutation<Updated, { input: { id: string; seo: Seo } }>(
    CollectionUpdateMutation,
  );
  return (
    <SearchListingCard
      url={`${storefront}/collections/${collection.handle}`}
      ownTitle={collection.title}
      ownText={collection.description}
      stored={collection.seo ?? NONE}
      save={async (seo) => wrongOf(await update.mutateAsync({ input: { id: collection.id, seo } }))}
    />
  );
}

/** A page's search engine listing (OS-09, ADR-601): blank, its title and the start of its text. */
export function PageSearchListing({
  page,
  storefront,
}: {
  page: Listed & { body: string };
  storefront: string;
}) {
  const update = useAdminMutation<Updated, { id: string; page: { seo: Seo } }>(PageUpdateMutation);
  return (
    <SearchListingCard
      url={`${storefront}/pages/${page.handle}`}
      ownTitle={page.title}
      ownText={page.body}
      stored={page.seo ?? NONE}
      save={async (seo) => wrongOf(await update.mutateAsync({ id: page.id, page: { seo } }))}
    />
  );
}

/**
 * A blog's search engine listing (OS-09, ADR-601): blank, its title, and the shop's own
 * description, which the preview leaves unsaid (ADR-244).
 */
export function BlogSearchListing({ blog, storefront }: { blog: Listed; storefront: string }) {
  const update = useAdminMutation<Updated, { id: string; blog: { seo: Seo } }>(BlogUpdateMutation);
  return (
    <SearchListingCard
      url={`${storefront}/blogs/${blog.handle}`}
      ownTitle={blog.title}
      ownText=""
      stored={blog.seo ?? NONE}
      save={async (seo) => wrongOf(await update.mutateAsync({ id: blog.id, blog: { seo } }))}
    />
  );
}

/**
 * An article's search engine listing (OS-09, ADR-601): blank, its title and the start of its
 * summary, or of its text where it has none.
 */
export function ArticleSearchListing({
  article,
  storefront,
}: {
  article: Listed & { body: string; summary: string | null; blog: { handle: string } };
  storefront: string;
}) {
  const update = useAdminMutation<Updated, { id: string; article: { seo: Seo } }>(
    ArticleUpdateMutation,
  );
  return (
    <SearchListingCard
      url={`${storefront}/blogs/${article.blog.handle}/${article.handle}`}
      ownTitle={article.title}
      ownText={article.summary || article.body}
      stored={article.seo ?? NONE}
      save={async (seo) => wrongOf(await update.mutateAsync({ id: article.id, article: { seo } }))}
    />
  );
}
