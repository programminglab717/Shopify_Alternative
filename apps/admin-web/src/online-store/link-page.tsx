import { Link } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  ExternalLink,
  ImageOff,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CollectionProductSearchQuery,
  LinkPageProductQuery,
  LinkPageQuery,
  LinkPageTapsQuery,
  LinkPageUpdateMutation,
} from '../api/operations';
import type {
  CollectionProductSearchData,
  LinkPage,
  LinkPageData,
  LinkPageProductData,
  LinkPageTapsData,
  LinkPageUpdateData,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { Translate } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** What the core takes on a link page (ADR-161). */
const LIMITS = { bio: 300, links: 10, title: 60, products: 24 } as const;

/** The periods taps are counted over, in days back from today. */
const PERIODS = ['7', '30', '90'] as const;
type Period = (typeof PERIODS)[number];

interface LinkDraft {
  key: number;
  title: string;
  url: string;
}

interface ProductDraft {
  key: number;
  productId: string;
  variantId: string | null;
}

/** The page as the core would keep it from what the form holds: trimmed, in order. */
function pageOf(bio: string, links: LinkDraft[], products: ProductDraft[]): LinkPage {
  return {
    bio: bio.trim(),
    links: links.map(({ title, url }) => ({ title: title.trim(), url: url.trim() })),
    products: products.map(({ productId, variantId }) => ({ productId, variantId })),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `list` with the item at `index` moved by `step`. */
function moved<T>(list: T[], index: number, step: number): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + step, 0, item!);
  return next;
}

/** A problem the core found, naming the link or product it is about by its place. */
function problemOf(error: UserError, t: Translate): string {
  const path = error.field ?? [];
  for (const [part, key] of [
    ['links', 'linkPage.linkProblem'],
    ['products', 'linkPage.productProblem'],
  ] as const) {
    const at = path.indexOf(part);
    const index = Number(path[at + 1]);
    if (at >= 0 && Number.isInteger(index)) {
      return t(key, { number: index + 1, message: error.message });
    }
  }
  return error.message;
}

/** Where the page is, to put in the shop's bios and send in chats. */
function PageAddress({ url, whatsapp }: { url: string; whatsapp: string | null }) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const [copied, setCopied] = useState(false);
  return (
    <FormSection title={t('linkPage.address')} hint={t('linkPage.addressHint')}>
      <code className="num break-all rounded-control bg-canvas px-2 py-1" dir="ltr">
        {url}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<Copy aria-hidden className="size-5" />}
          onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}
        >
          {copied ? t('staff.copied') : t('staff.copy')}
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-4 font-medium md:min-h-10"
        >
          <ExternalLink aria-hidden className="size-5" />
          {t('linkPage.open')}
        </a>
      </div>
      <p className="text-secondary">
        {whatsapp ? (
          t('linkPage.whatsapp', { number: whatsapp })
        ) : (
          <>
            {t('linkPage.noWhatsapp')}{' '}
            <Link
              to="/$shopId/settings/shop"
              params={{ shopId }}
              className="font-medium text-primary underline"
            >
              {t('settings.shop')}
            </Link>
          </>
        )}
      </p>
    </FormSection>
  );
}

/** One of the page's products: its picture, title and price, and the variant it goes with. */
function ProductRow({
  draft,
  number,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  draft: ProductDraft;
  number: number;
  last: boolean;
  onChange: (variantId: string | null) => void;
  onMove: (step: number) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const query = useAdminQuery<LinkPageProductData>(
    ['linkPageProduct', draft.productId],
    LinkPageProductQuery,
    { id: draft.productId },
  );
  const product = query.data?.product;
  const variant = product?.variants.find((each) => each.id === draft.variantId);
  const price = (variant ?? product?.variants[0])?.price;
  const image = product?.media.find((each) => each.previewImage)?.previewImage?.url;
  const title = product
    ? product.title
    : query.isPending
      ? t('state.loading')
      : t('linkPage.productGone');

  return (
    <li className="flex flex-col gap-2 rounded-control border border-line p-3">
      <div className="flex items-center gap-3">
        {image ? (
          <img src={image} alt="" className="size-12 rounded-control object-cover" />
        ) : (
          <span className="flex size-12 items-center justify-center rounded-control bg-canvas">
            <ImageOff aria-hidden className="size-5 text-secondary" />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span dir="auto" className="font-medium">
            {title}
          </span>
          {price && <span className="num text-secondary">{formatMoney(price.amount)}</span>}
          {product && product.status !== 'ACTIVE' && (
            <span className="text-warning">{t('linkPage.notActive')}</span>
          )}
        </span>
      </div>
      {product && product.variants.length > 1 && (
        <SelectField
          label={t('linkPage.variant', { number })}
          value={draft.variantId ?? ''}
          options={[
            { value: '', label: t('linkPage.anyVariant') },
            ...product.variants.map((each) => ({
              value: each.id,
              label: `${each.title} · ${formatMoney(each.price.amount)}`,
            })),
          ]}
          onChange={(value) => onChange(value || null)}
        />
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          variant="tertiary"
          aria-label={t('linkPage.productUp', { number })}
          disabled={number === 1}
          icon={<ArrowUp aria-hidden className="size-5" />}
          onClick={() => onMove(-1)}
        />
        <Button
          variant="tertiary"
          aria-label={t('linkPage.productDown', { number })}
          disabled={last}
          icon={<ArrowDown aria-hidden className="size-5" />}
          onClick={() => onMove(1)}
        />
        <Button
          variant="danger"
          aria-label={t('linkPage.productRemove', { number })}
          icon={<Trash2 aria-hidden className="size-5" />}
          onClick={onRemove}
        />
      </div>
    </li>
  );
}

/** Products found by name, to add to the page. */
function ProductFinder({
  onAdd,
  note,
}: {
  onAdd: (productId: string, title: string) => void;
  note: string | null;
}) {
  const { t } = useLocale();
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const query = useAdminQuery<CollectionProductSearchData>(
    ['collectionProductSearch', searched],
    CollectionProductSearchQuery,
    { query: searched },
    { enabled: searched !== null },
  );
  const find = () => setSearched(words.trim());
  return (
    <div className="flex flex-col gap-2">
      <div role="search" className="flex gap-2">
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            find();
          }}
          aria-label={t('linkPage.findProduct')}
          placeholder={t('linkPage.findProduct')}
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button variant="secondary" icon={<Search aria-hidden className="size-5" />} onClick={find}>
          {t('drafts.find')}
        </Button>
      </div>
      {query.data && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {query.data.products.nodes.length === 0 && (
            <li className="px-3 py-2 text-secondary">{t('drafts.noProducts')}</li>
          )}
          {query.data.products.nodes.map((product) => (
            <li key={product.id} className="flex items-center gap-3 px-3 py-2">
              <span dir="auto" className="min-w-0 flex-1">
                {product.title}
              </span>
              <Button
                variant="tertiary"
                icon={<Plus aria-hidden className="size-5" />}
                aria-label={t('drafts.add', { title: product.title })}
                onClick={() => onAdd(product.id, product.title)}
              >
                {t('drafts.addShort')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-secondary">{note}</p>}
    </div>
  );
}

/** What the page says of the shop, its links and its products, saved together. */
function LinkPageForm({ page }: { page: LinkPage }) {
  const { t } = useLocale();
  const update = useAdminMutation<LinkPageUpdateData, { input: { linkPage: Partial<LinkPage> } }>(
    LinkPageUpdateMutation,
  );
  const next = useRef(0);
  const keyed = <T,>(items: T[]) => items.map((item) => ({ ...item, key: (next.current += 1) }));
  const [bio, setBio] = useState(page.bio);
  const [links, setLinks] = useState<LinkDraft[]>(() => keyed(page.links));
  const [products, setProducts] = useState<ProductDraft[]>(() => keyed(page.products));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const now = pageOf(bio, links, products);
  const input: Partial<LinkPage> = {
    ...(now.bio !== page.bio && { bio: now.bio }),
    ...(!same(now.links, page.links) && { links: now.links }),
    ...(!same(now.products, page.products) && { products: now.products }),
  };
  const changed = Object.keys(input).length > 0;

  const setLink = (index: number, change: Partial<LinkDraft>) =>
    setLinks((all) => all.map((each, at) => (at === index ? { ...each, ...change } : each)));
  const setProduct = (index: number, change: Partial<ProductDraft>) =>
    setProducts((all) => all.map((each, at) => (at === index ? { ...each, ...change } : each)));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    setProblem(null);
    setSaved(false);
    try {
      const { onlineStorePreferencesUpdate: result } = await update.mutateAsync({
        input: { linkPage: input },
      });
      if (result.userErrors.length > 0) {
        setProblem(result.userErrors.map((error) => problemOf(error, t)).join(' '));
        return;
      }
      const kept = result.preferences!.linkPage;
      setBio(kept.bio);
      setLinks(keyed(kept.links));
      setProducts(keyed(kept.products));
      setSaved(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('linkPage.about')} hint={t('linkPage.aboutHint')}>
        <div className="flex flex-col gap-1">
          <label htmlFor="link-page-bio" className="font-medium">
            {t('linkPage.bio')}
          </label>
          <textarea
            id="link-page-bio"
            value={bio}
            rows={3}
            dir="auto"
            maxLength={LIMITS.bio}
            onChange={(event) => setBio(event.target.value)}
            className="rounded-control border border-line bg-surface px-3 py-2 text-text"
          />
          <span className="text-secondary">
            {t('linkPage.bioCount', { count: bio.trim().length, most: LIMITS.bio })}
          </span>
        </div>
      </FormSection>

      <FormSection title={t('linkPage.links')} hint={t('linkPage.linksHint')}>
        {links.length > 0 && (
          <ol className="flex flex-col gap-2">
            {links.map((link, index) => {
              const number = index + 1;
              return (
                <li
                  key={link.key}
                  className="flex flex-col gap-2 rounded-control border border-line p-3"
                >
                  <TextField
                    label={t('linkPage.linkTitle', { number })}
                    dir="auto"
                    maxLength={LIMITS.title}
                    value={link.title}
                    onChange={(event) => setLink(index, { title: event.target.value })}
                  />
                  <TextField
                    label={t('linkPage.linkUrl', { number })}
                    hint={t('linkPage.linkUrlHint')}
                    ltr
                    value={link.url}
                    onChange={(event) => setLink(index, { url: event.target.value })}
                  />
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="tertiary"
                      aria-label={t('linkPage.linkUp', { number })}
                      disabled={index === 0}
                      icon={<ArrowUp aria-hidden className="size-5" />}
                      onClick={() => setLinks((all) => moved(all, index, -1))}
                    />
                    <Button
                      variant="tertiary"
                      aria-label={t('linkPage.linkDown', { number })}
                      disabled={index === links.length - 1}
                      icon={<ArrowDown aria-hidden className="size-5" />}
                      onClick={() => setLinks((all) => moved(all, index, 1))}
                    />
                    <Button
                      variant="danger"
                      aria-label={t('linkPage.linkRemove', { number })}
                      icon={<Trash2 aria-hidden className="size-5" />}
                      onClick={() => setLinks((all) => all.filter((_, at) => at !== index))}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <Button
          variant="secondary"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          disabled={links.length >= LIMITS.links}
          onClick={() =>
            setLinks((all) => [...all, { key: (next.current += 1), title: '', url: '' }])
          }
        >
          {t('linkPage.addLink')}
        </Button>
        {links.length >= LIMITS.links && (
          <p className="text-secondary">{t('linkPage.linksFull', { count: LIMITS.links })}</p>
        )}
      </FormSection>

      <FormSection title={t('linkPage.products')} hint={t('linkPage.productsHint')}>
        {products.length > 0 && (
          <ol className="flex flex-col gap-2">
            {products.map((product, index) => (
              <ProductRow
                key={product.key}
                draft={product}
                number={index + 1}
                last={index === products.length - 1}
                onChange={(variantId) => setProduct(index, { variantId })}
                onMove={(step) => setProducts((all) => moved(all, index, step))}
                onRemove={() => setProducts((all) => all.filter((_, at) => at !== index))}
              />
            ))}
          </ol>
        )}
        {products.length < LIMITS.products ? (
          <ProductFinder
            note={note}
            onAdd={(productId, title) => {
              // The page shows a product once as a whole, and again only with another variant.
              if (products.some((each) => each.productId === productId && !each.variantId)) {
                setNote(t('linkPage.already', { title }));
                return;
              }
              setNote(null);
              setProducts((all) => [
                ...all,
                { key: (next.current += 1), productId, variantId: null },
              ]);
            }}
          />
        ) : (
          <p className="text-secondary">{t('linkPage.productsFull', { count: LIMITS.products })}</p>
        )}
      </FormSection>

      {problem && <Alert tone="danger">{problem}</Alert>}
      {saved && !changed && <Alert tone="success">{t('storefront.saved')}</Alert>}
      <Button type="submit" className="self-start" busy={update.isPending} disabled={!changed}>
        {t('linkPage.save')}
      </Button>
    </form>
  );
}

/** How often each of the page's links was tapped lately, its chat on WhatsApp among them. */
function LinkTaps() {
  const { t } = useLocale();
  const [period, setPeriod] = useState<Period>('30');
  const [now] = useState(() => Date.now());
  const day = 24 * 60 * 60 * 1000;
  const query = useAdminQuery<LinkPageTapsData>(['linkPageTaps', period], LinkPageTapsQuery, {
    from: new Date(now - (Number(period) - 1) * day).toISOString(),
    before: new Date(now + day).toISOString(),
  });

  return (
    <FormSection title={t('linkPage.taps')} hint={t('linkPage.tapsHint')}>
      <SelectField
        label={t('linkPage.period')}
        value={period}
        options={PERIODS.map((days) => ({
          value: days,
          label: t('linkPage.lastDays', { count: Number(days) }),
        }))}
        onChange={setPeriod}
      />
      {query.isPending && <Loading label={t('state.loading')} />}
      {query.isError && <Alert tone="danger">{errorText(query.error, t)}</Alert>}
      {query.data && (
        <>
          <p className="font-medium">
            {t('linkPage.tapsTotal', { count: formatCount(query.data.linkPageTaps.total) })}
          </p>
          {query.data.linkPageTaps.links.length > 0 && (
            <ul
              aria-label={t('linkPage.taps')}
              className="flex flex-col divide-y divide-line rounded-control border border-line"
            >
              {query.data.linkPageTaps.links.map((link) => (
                <li
                  key={`${link.source} ${link.url}`}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto">
                      {link.source === 'WHATSAPP'
                        ? t('linkPage.whatsappChat')
                        : link.source === 'REMOVED'
                          ? t('linkPage.removed')
                          : link.title}
                    </span>
                    <span className="num truncate text-secondary" dir="ltr">
                      {link.url}
                    </span>
                  </span>
                  <span className="num font-medium">{formatCount(link.taps)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </FormSection>
  );
}

/**
 * The shop's link page (CH-07), for owners and managers: where it is, a line about the shop, up to
 * ten links and 24 products to buy at once, and how often each link was tapped.
 */
export function LinkPageTab() {
  const { t } = useLocale();
  const query = useAdminQuery<LinkPageData>(['linkPage'], LinkPageQuery);
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { shop, onlineStorePreferences: preferences } = query.data;
  return (
    <div className="flex flex-col gap-4">
      <PageAddress
        url={`${shop.url.replace(/\/$/, '')}/links`}
        whatsapp={preferences.whatsappNumber}
      />
      <LinkPageForm page={preferences.linkPage} />
      <LinkTaps />
    </div>
  );
}
