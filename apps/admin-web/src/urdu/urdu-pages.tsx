import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  ArticleQuery,
  BlogQuery,
  CollectionQuery,
  MenusQuery,
  PageQuery,
  ProductQuery,
} from '../api/operations';
import type {
  ArticleData,
  BlogData,
  CollectionData,
  MenuLink,
  MenusData,
  PageData,
  ProductData,
  ProductDetail,
} from '../api/types';
import type { StaffRole } from '../auth/session';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import { useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { EmptyState, ErrorState, Loading } from '../ui/feedback';
import { URDU_LINK, UrduSummary, UrduWords, WRITES_URDU, type UrduSection } from './in-urdu';

/** A product's words in Urdu: its own fields, then its options, each with its values. */
export function productInUrdu(
  product: Pick<ProductDetail, 'id' | 'options'>,
  t: Translate,
): UrduSection[] {
  return [
    { title: t('urdu.product'), things: [{ id: product.id, kind: 'product' }] },
    {
      title: t('urdu.options'),
      hint: t('urdu.optionsHint'),
      things: product.options.flatMap((option) => [
        { id: option.id, kind: 'option' as const },
        ...option.optionValues.map((value) => ({ id: value.id, kind: 'value' as const, depth: 1 })),
      ]),
    },
  ];
}

const collectionInUrdu = (id: string, t: Translate): UrduSection[] => [
  { title: t('urdu.collection'), things: [{ id, kind: 'collection' }] },
];

const pageInUrdu = (id: string, t: Translate): UrduSection[] => [
  { title: t('urdu.page'), things: [{ id, kind: 'page' }] },
];

const blogInUrdu = (id: string, t: Translate): UrduSection[] => [
  { title: t('urdu.blog'), things: [{ id, kind: 'blog' }] },
];

const articleInUrdu = (id: string, t: Translate): UrduSection[] => [
  { title: t('urdu.article'), things: [{ id, kind: 'article' }] },
];

/** A menu's links, each followed by those under it, a level further in. */
function linksOf(items: readonly MenuLink[], depth = 0): UrduSection['things'] {
  return items.flatMap((item) => [
    { id: item.id, kind: 'link' as const, depth },
    ...linksOf(item.items ?? [], depth + 1),
  ]);
}

/** A menu's title, then its links as the menu has them, those under another set in. */
function menuInUrdu(menu: { id: string; items: readonly MenuLink[] }, t: Translate): UrduSection[] {
  return [
    { title: t('urdu.menu'), things: [{ id: menu.id, kind: 'menu' }] },
    { title: t('urdu.links'), hint: t('urdu.linksHint'), things: linksOf(menu.items) },
  ];
}

/** The home page's words for search engines, kept by the shop itself (ADR-245). */
const homeInUrdu = (shopId: string, t: Translate): UrduSection[] => [
  {
    title: t('urdu.homePage'),
    hint: t('urdu.homePageHint'),
    things: [{ id: shopId, kind: 'shop' }],
  },
];

/** Those who change menus and the storefront's preferences, and write its Urdu. */
const MENUS_IN_URDU: readonly StaffRole[] = ['owner', 'manager'];

const BACK =
  'inline-flex min-h-10 max-w-full items-center gap-1 self-start text-secondary hover:text-text';

/**
 * The page of something's Urdu (OS-06): its name and what its Urdu does, then its fields beside
 * their Urdu, for those who write the shop's Urdu.
 */
function UrduPage({
  back,
  name,
  sections,
}: {
  back: ReactNode;
  name: string;
  sections: readonly UrduSection[];
}) {
  const { t } = useLocale();
  const { role } = useShop();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {back}
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
          {t('urdu.title', { name })}
        </h1>
        <p className="text-secondary">{t('urdu.intro')}</p>
      </div>
      {WRITES_URDU.includes(role) ? (
        <UrduWords sections={sections} />
      ) : (
        <EmptyState title={t('urdu.cannot')} />
      )}
    </div>
  );
}

/** What a page shows while what it is about loads, cannot be read, or is not the shop's. */
function Waiting({
  query,
  missing,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  missing: string;
}) {
  const { t } = useLocale();
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  return <EmptyState title={missing} />;
}

/** A product's title, description, type, words for search engines and options in Urdu. */
export function ProductUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { productId } = useParams({ from: '/$shopId/products/$productId/urdu' });
  const query = useAdminQuery<ProductData>(['product', productId], ProductQuery, {
    id: productId,
  });
  const product = query.data?.product;
  if (!product) return <Waiting query={query} missing={t('product.notFound')} />;
  return (
    <UrduPage
      back={
        <Link to="/$shopId/products/$productId" params={{ shopId, productId }} className={BACK}>
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {product.title}
          </span>
        </Link>
      }
      name={product.title}
      sections={productInUrdu(product, t)}
    />
  );
}

/** A collection's title, description and words for search engines in Urdu. */
export function CollectionUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { collectionId } = useParams({ from: '/$shopId/collections/$collectionId/urdu' });
  const query = useAdminQuery<CollectionData>(['collection', collectionId], CollectionQuery, {
    id: collectionId,
  });
  const collection = query.data?.collection;
  if (!collection) return <Waiting query={query} missing={t('collection.notFound')} />;
  return (
    <UrduPage
      back={
        <Link
          to="/$shopId/collections/$collectionId"
          params={{ shopId, collectionId }}
          className={BACK}
        >
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {collection.title}
          </span>
        </Link>
      }
      name={collection.title}
      sections={collectionInUrdu(collection.id, t)}
    />
  );
}

/** A page's title, text and words for search engines in Urdu. */
export function PageUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { pageId } = useParams({ from: '/$shopId/online-store/pages/$pageId/urdu' });
  const query = useAdminQuery<PageData>(['page', pageId], PageQuery, { id: pageId });
  const page = query.data?.page;
  if (!page) return <Waiting query={query} missing={t('pages.notFound')} />;
  return (
    <UrduPage
      back={
        <Link to="/$shopId/online-store/pages/$pageId" params={{ shopId, pageId }} className={BACK}>
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {page.title}
          </span>
        </Link>
      }
      name={page.title}
      sections={pageInUrdu(page.id, t)}
    />
  );
}

/** How much of a product is in Urdu, on its page, and the way to its Urdu. */
export function ProductUrduCard({ product }: { product: ProductDetail }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={productInUrdu(product, t)}
      link={(children) => (
        <Link
          to="/$shopId/products/$productId/urdu"
          params={{ shopId, productId: product.id }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** How much of a collection is in Urdu, on its page, and the way to its Urdu. */
export function CollectionUrduCard({ collectionId }: { collectionId: string }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={collectionInUrdu(collectionId, t)}
      link={(children) => (
        <Link
          to="/$shopId/collections/$collectionId/urdu"
          params={{ shopId, collectionId }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** How much of a page is in Urdu, on its page, and the way to its Urdu. */
export function PageUrduCard({ pageId }: { pageId: string }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={pageInUrdu(pageId, t)}
      link={(children) => (
        <Link
          to="/$shopId/online-store/pages/$pageId/urdu"
          params={{ shopId, pageId }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** A blog's title and words for search engines in Urdu. */
export function BlogUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { blogId } = useParams({ from: '/$shopId/online-store/blogs/$blogId/urdu' });
  const query = useAdminQuery<BlogData>(['blog', blogId], BlogQuery, { id: blogId });
  const blog = query.data?.blog;
  if (!blog) return <Waiting query={query} missing={t('blogs.notFound')} />;
  return (
    <UrduPage
      back={
        <Link to="/$shopId/online-store/blogs/$blogId" params={{ shopId, blogId }} className={BACK}>
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {blog.title}
          </span>
        </Link>
      }
      name={blog.title}
      sections={blogInUrdu(blog.id, t)}
    />
  );
}

/** An article's title, text, summary and words for search engines in Urdu. */
export function ArticleUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const { articleId } = useParams({ from: '/$shopId/online-store/articles/$articleId/urdu' });
  const query = useAdminQuery<ArticleData>(['article', articleId], ArticleQuery, {
    id: articleId,
  });
  const article = query.data?.article;
  if (!article) return <Waiting query={query} missing={t('articles.notFound')} />;
  return (
    <UrduPage
      back={
        <Link
          to="/$shopId/online-store/articles/$articleId"
          params={{ shopId, articleId }}
          className={BACK}
        >
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {article.title}
          </span>
        </Link>
      }
      name={article.title}
      sections={articleInUrdu(article.id, t)}
    />
  );
}

/** A menu's title and each of its links in Urdu; owners and managers, who change menus. */
export function MenuUrduPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const { menuId } = useParams({ from: '/$shopId/online-store/menus/$menuId/urdu' });
  const allowed = MENUS_IN_URDU.includes(role);
  const query = useAdminQuery<MenusData>(['menus'], MenusQuery, {}, { enabled: allowed });
  if (!allowed) return <EmptyState title={t('menus.cannot')} />;
  const menu = query.data?.menus.nodes.find((each) => each.id === menuId);
  if (!menu) return <Waiting query={query} missing={t('menus.notFound')} />;
  return (
    <UrduPage
      back={
        <Link to="/$shopId/online-store/menus/$menuId" params={{ shopId, menuId }} className={BACK}>
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          <span className="truncate" dir="auto">
            {menu.title}
          </span>
        </Link>
      }
      name={menu.title}
      sections={menuInUrdu(menu, t)}
    />
  );
}

/** The home page's title and description for search engines in Urdu, the shop's own (ADR-245). */
export function HomeUrduPage() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  return (
    <UrduPage
      back={
        <Link
          to="/$shopId/online-store"
          params={{ shopId }}
          search={{ tab: 'storefront' }}
          className={BACK}
        >
          <ArrowLeft aria-hidden className="size-5 shrink-0 rtl:rotate-180" />
          {t('onlineStore.storefront')}
        </Link>
      }
      name={t('urdu.homePageName')}
      sections={homeInUrdu(shopId, t)}
    />
  );
}

/** How much of a blog is in Urdu, on its page, and the way to its Urdu. */
export function BlogUrduCard({ blogId }: { blogId: string }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={blogInUrdu(blogId, t)}
      link={(children) => (
        <Link
          to="/$shopId/online-store/blogs/$blogId/urdu"
          params={{ shopId, blogId }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** How much of an article is in Urdu, on its page, and the way to its Urdu. */
export function ArticleUrduCard({ articleId }: { articleId: string }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!WRITES_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={articleInUrdu(articleId, t)}
      link={(children) => (
        <Link
          to="/$shopId/online-store/articles/$articleId/urdu"
          params={{ shopId, articleId }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** How much of a menu is in Urdu, on its page, and the way to its Urdu. */
export function MenuUrduCard({ menu }: { menu: { id: string; items: readonly MenuLink[] } }) {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!MENUS_IN_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={menuInUrdu(menu, t)}
      link={(children) => (
        <Link
          to="/$shopId/online-store/menus/$menuId/urdu"
          params={{ shopId, menuId: menu.id }}
          className={URDU_LINK}
        >
          {children}
        </Link>
      )}
    />
  );
}

/** How much of the home page's words are in Urdu, beside them, and the way to their Urdu. */
export function HomeUrduCard() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  if (!MENUS_IN_URDU.includes(role)) return null;
  return (
    <UrduSummary
      sections={homeInUrdu(shopId, t)}
      link={(children) => (
        <Link to="/$shopId/online-store/home-page/urdu" params={{ shopId }} className={URDU_LINK}>
          {children}
        </Link>
      )}
    />
  );
}
