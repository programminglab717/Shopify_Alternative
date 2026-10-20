import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowDown, ArrowLeft, ArrowUp, CornerDownRight, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CollectionProductSearchQuery,
  CollectionsQuery,
  MenuCreateMutation,
  MenuDeleteMutation,
  MenusQuery,
  MenuUpdateMutation,
  PagesQuery,
  PoliciesQuery,
  ProductTagsQuery,
} from '../api/operations';
import type {
  CollectionProductSearchData,
  CollectionsData,
  Menu,
  MenuItemType,
  MenuLink,
  MenuMutationData,
  MenusData,
  PagesData,
  PoliciesData,
  ProductTagsData,
} from '../api/types';
import { gate, permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { MenuUrduCard } from '../urdu/urdu-pages';

/** Those who change the shop's menus, as its navigation: owners and managers. */
export const EDITS_MENUS = gate(['owner', 'manager'], 'write_online_store_navigation');

/** Three levels of links at most, as the core keeps them. */
const LEVELS = 3;

/** What a new link can lead to; a link to a blog or an article keeps its own. */
const OFFERED: readonly MenuItemType[] = [
  'FRONTPAGE',
  'CATALOG',
  'COLLECTION',
  'PRODUCT',
  'PAGE',
  'SHOP_POLICY',
  'SEARCH',
  'HTTP',
];

/** The links that name what they lead to by ID. */
const RESOURCED: readonly MenuItemType[] = [
  'COLLECTION',
  'PRODUCT',
  'PAGE',
  'BLOG',
  'ARTICLE',
  'SHOP_POLICY',
];

/** The links that narrow to products with some tags (ADR-644). */
const TAGGED: readonly MenuItemType[] = ['COLLECTION', 'CATALOG'];

/** Tags as typed, comma-separated: each once whatever its case, without blanks. */
function tagsOf(text: string): string[] {
  const tags = new Map<string, string>();
  for (const tag of text.split(',').map((each) => each.trim())) {
    if (tag !== '' && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return [...tags.values()];
}

/** A link as the editor holds it: what the core keeps, and what it last showed as leading to. */
interface Draft {
  key: string;
  id?: string;
  title: string;
  type: MenuItemType;
  resourceId: string | null;
  url: string;
  /** Its tags, comma-separated as typed. */
  tags: string;
  /** Where it led when read, or what was chosen for it since. */
  shown: string | null;
  items: Draft[];
}

let made = 0;
const newKey = () => `new-${(made += 1)}`;

function draftsOf(links: readonly MenuLink[]): Draft[] {
  return links.map((link) => ({
    key: link.id,
    id: link.id,
    title: link.title,
    type: link.type,
    resourceId: link.resourceId,
    url: link.type === 'HTTP' ? (link.url ?? '') : '',
    tags: (link.tags ?? []).join(', '),
    shown: link.url,
    items: draftsOf(link.items ?? []),
  }));
}

/** The links as the core takes them: IDs kept, each with what it leads to. */
export function linksInput(drafts: readonly Draft[]): Record<string, unknown>[] {
  return drafts.map((draft) => ({
    ...(draft.id && { id: draft.id }),
    title: draft.title.trim(),
    type: draft.type,
    ...(RESOURCED.includes(draft.type) && { resourceId: draft.resourceId }),
    ...(draft.type === 'HTTP' && { url: draft.url.trim() }),
    ...(TAGGED.includes(draft.type) &&
      tagsOf(draft.tags).length > 0 && { tags: tagsOf(draft.tags) }),
    items: linksInput(draft.items),
  }));
}

/** Whether every link has a title and leads somewhere. */
function complete(drafts: readonly Draft[]): boolean {
  return drafts.every(
    (draft) =>
      draft.title.trim() !== '' &&
      (!RESOURCED.includes(draft.type) || !!draft.resourceId) &&
      (draft.type !== 'HTTP' || draft.url.trim() !== '') &&
      complete(draft.items),
  );
}

const count = (drafts: readonly Draft[]): number =>
  drafts.reduce((sum, draft) => sum + 1 + count(draft.items), 0);

type Path = readonly number[];

/** The links with the one at `path` changed by `change`, or taken out where it gives null. */
function at(drafts: readonly Draft[], path: Path, change: (draft: Draft) => Draft | null): Draft[] {
  const [index, ...rest] = path;
  return drafts.flatMap((draft, here) => {
    if (here !== index) return [draft];
    if (rest.length > 0) return [{ ...draft, items: at(draft.items, rest, change) }];
    const next = change(draft);
    return next ? [next] : [];
  });
}

/** The links with the one at `path` swapped with its neighbour `by` places along. */
function moved(drafts: readonly Draft[], path: Path, by: -1 | 1): Draft[] {
  if (path.length > 1) {
    return at(drafts, path.slice(0, 1), (draft) => ({
      ...draft,
      items: moved(draft.items, path.slice(1), by),
    }));
  }
  const index = path[0]!;
  const next = [...drafts];
  [next[index], next[index + by]] = [next[index + by]!, next[index]!];
  return next;
}

const blank = (): Draft => ({
  key: newKey(),
  title: '',
  type: 'COLLECTION',
  resourceId: null,
  url: '',
  tags: '',
  shown: null,
  items: [],
});

/** Products found by name, to link to one. */
function ProductTarget({ onChoose }: { onChoose: (id: string, title: string) => void }) {
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
          aria-label={t('menus.findProduct')}
          placeholder={t('menus.findProduct')}
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
            <li key={product.id}>
              <button
                type="button"
                className="flex min-h-10 w-full items-center px-3 text-start hover:bg-canvas"
                onClick={() => onChoose(product.id, product.title)}
              >
                {t('menus.linkTo', { title: product.title })}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Choices {
  collections: { value: string; label: string }[];
  pages: { value: string; label: string }[];
  /** The shop's policies that have words (ADR-640). */
  policies: { value: string; label: string }[];
  /** The tags its products use, the most used first, to add to a link's (ADR-646). */
  tags: string[];
}

/** How many of the shop's tags a link's tags field offers. */
const TAGS_OFFERED = 12;

/**
 * The shop's tags in use that a link does not have yet, each added with a tap (ADR-646): for a
 * link to a collection, those of its products alone, as narrowing it by others finds none
 * (ADR-660).
 */
function TagsOffered({
  number,
  chosen,
  tags,
  collectionId,
  add,
}: {
  number: string;
  chosen: readonly string[];
  tags: readonly string[];
  collectionId: string | null;
  add: (tag: string) => void;
}) {
  const { t } = useLocale();
  const its = useAdminQuery<ProductTagsData>(
    ['productTags'],
    ProductTagsQuery,
    { collectionId },
    { enabled: collectionId !== null },
  );
  const has = new Set(chosen.map((tag) => tag.toLowerCase()));
  const offered = (collectionId ? (its.data?.productTags ?? []) : tags)
    .filter((tag) => !has.has(tag.toLowerCase()))
    .slice(0, TAGS_OFFERED);
  if (offered.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t(collectionId ? 'menus.collectionTags' : 'menus.tagsInUse')}
      </span>
      {offered.map((tag) => (
        <button
          key={tag}
          type="button"
          aria-label={t('menus.addTag', { tag, number })}
          className="min-h-8 rounded-control border border-line bg-surface px-2 text-[length:var(--hatti-type-body-sm-size)]"
          dir="auto"
          onClick={() => add(tag)}
        >
          + {tag}
        </button>
      ))}
    </div>
  );
}

/** One link: its title, what it leads to, moved, taken out, and the links under it. */
function LinkEditor({
  draft,
  path,
  last,
  choices,
  change,
}: {
  draft: Draft;
  path: Path;
  last: boolean;
  choices: Choices;
  change: (drafts: (all: Draft[]) => Draft[]) => void;
}) {
  const { t } = useLocale();
  const number = path.map((index) => index + 1).join('.');
  const set = (next: Partial<Draft>) =>
    change((all) => at(all, path, (old) => ({ ...old, ...next })));
  const types = OFFERED.includes(draft.type) ? OFFERED : [...OFFERED, draft.type];
  const choose = (list: { value: string; label: string }[], none: MessageKey) => [
    { value: '', label: t(none) },
    ...list,
    // A link to something gone keeps its ID until another is chosen.
    ...(draft.resourceId && !list.some((each) => each.value === draft.resourceId)
      ? [{ value: draft.resourceId, label: draft.shown ?? t('menus.gone') }]
      : []),
  ];

  return (
    <li className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 rounded-control border border-line p-3">
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('menus.linkTitle', { number })}
            dir="auto"
            className="w-48"
            value={draft.title}
            onChange={(event) => set({ title: event.target.value })}
          />
          <SelectField
            label={t('menus.linkType', { number })}
            value={draft.type}
            options={types.map((type) => ({
              value: type,
              label: t(`menus.type.${type}` as MessageKey),
            }))}
            onChange={(type) => set({ type, resourceId: null, shown: null, url: '' })}
          />
          {draft.type === 'COLLECTION' && (
            <SelectField
              label={t('menus.linkCollection', { number })}
              value={draft.resourceId ?? ''}
              options={choose(choices.collections, 'menus.chooseCollection')}
              onChange={(resourceId) => set({ resourceId: resourceId || null })}
            />
          )}
          {draft.type === 'PAGE' && (
            <SelectField
              label={t('menus.linkPage', { number })}
              value={draft.resourceId ?? ''}
              options={choose(choices.pages, 'menus.choosePage')}
              onChange={(resourceId) => set({ resourceId: resourceId || null })}
            />
          )}
          {draft.type === 'SHOP_POLICY' && (
            <SelectField
              label={t('menus.linkPolicy', { number })}
              value={draft.resourceId ?? ''}
              options={choose(choices.policies, 'menus.choosePolicy')}
              onChange={(resourceId) => set({ resourceId: resourceId || null })}
            />
          )}
          {TAGGED.includes(draft.type) && (
            <TextField
              label={t('menus.linkTags', { number })}
              hint={t('menus.linkTagsHint')}
              dir="auto"
              className="w-48"
              value={draft.tags}
              onChange={(event) => set({ tags: event.target.value })}
            />
          )}
          {draft.type === 'HTTP' && (
            <TextField
              label={t('menus.linkUrl', { number })}
              hint={t('menus.linkUrlHint')}
              ltr
              className="w-64"
              value={draft.url}
              onChange={(event) => set({ url: event.target.value })}
            />
          )}
        </div>
        {TAGGED.includes(draft.type) && (
          <TagsOffered
            number={number}
            chosen={tagsOf(draft.tags)}
            tags={choices.tags}
            collectionId={draft.type === 'COLLECTION' ? draft.resourceId || null : null}
            add={(tag) => set({ tags: [...tagsOf(draft.tags), tag].join(', ') })}
          />
        )}
        {draft.type === 'PRODUCT' && (
          <div className="flex flex-col gap-2">
            <p className="text-secondary">
              {draft.resourceId
                ? t('menus.leadsTo', { where: draft.shown ?? t('menus.gone') })
                : t('menus.chooseProduct')}
            </p>
            <ProductTarget onChoose={(resourceId, title) => set({ resourceId, shown: title })} />
          </div>
        )}
        {(draft.type === 'BLOG' || draft.type === 'ARTICLE') && (
          <p className="text-secondary" dir="ltr">
            {draft.shown ?? t('menus.gone')}
          </p>
        )}
        <div className="flex flex-wrap gap-1">
          <Button
            variant="tertiary"
            aria-label={t('menus.moveUp', { number })}
            disabled={path.at(-1) === 0}
            icon={<ArrowUp aria-hidden className="size-5" />}
            onClick={() => change((all) => moved(all, path, -1))}
          />
          <Button
            variant="tertiary"
            aria-label={t('menus.moveDown', { number })}
            disabled={last}
            icon={<ArrowDown aria-hidden className="size-5" />}
            onClick={() => change((all) => moved(all, path, 1))}
          />
          {path.length < LEVELS && (
            <Button
              variant="tertiary"
              icon={<CornerDownRight aria-hidden className="size-5" />}
              aria-label={t('menus.addUnder', { number })}
              onClick={() =>
                change((all) =>
                  at(all, path, (old) => ({ ...old, items: [...old.items, blank()] })),
                )
              }
            >
              {t('menus.addUnderShort')}
            </Button>
          )}
          <Button
            variant="danger"
            aria-label={t('menus.remove', { number })}
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={() => change((all) => at(all, path, () => null))}
          />
        </div>
      </div>
      {draft.items.length > 0 && (
        <ol className="flex flex-col gap-2 border-s-2 border-line ps-4">
          {draft.items.map((child, index) => (
            <LinkEditor
              key={child.key}
              draft={child}
              path={[...path, index]}
              last={index === draft.items.length - 1}
              choices={choices}
              change={change}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

/** The shop's menus, each with how many links it holds. */
export function MenusList() {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const query = useAdminQuery<MenusData>(['menus'], MenusQuery);
  return (
    <div className="flex flex-col gap-3">
      <Link
        to="/$shopId/online-store/menus/$menuId"
        params={{ shopId, menuId: 'new' }}
        className="inline-flex min-h-12 items-center gap-2 self-start rounded-control bg-primary px-4 font-medium text-on-primary hover:bg-primary-strong md:min-h-10"
      >
        <Plus aria-hidden className="size-5" />
        {t('menus.add')}
      </Link>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.menus.nodes.map((menu) => (
              <li key={menu.id}>
                <Link
                  to="/$shopId/online-store/menus/$menuId"
                  params={{ shopId, menuId: menu.id }}
                  className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-canvas"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium" dir="auto">
                      {menu.title}
                    </span>
                    <span className="text-secondary" dir="ltr">
                      {menu.handle}
                    </span>
                  </span>
                  <span className="num text-secondary">
                    {t('menus.count', { count: formatCount(count(draftsOf(menu.items))) })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** A handle from a title, as themes name menus: lower case, words joined by hyphens. */
export const handleOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

/** A menu's title and its links, saved whole. */
function MenuForm({ menu }: { menu: Menu | null }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const collections = useAdminQuery<CollectionsData>(['collections', null], CollectionsQuery, {
    query: null,
  });
  const pages = useAdminQuery<PagesData>(['pages'], PagesQuery);
  const policies = useAdminQuery<PoliciesData>(['policies'], PoliciesQuery);
  const tags = useAdminQuery<ProductTagsData>(['productTags'], ProductTagsQuery, {
    collectionId: null,
  });
  const create = useAdminMutation<MenuMutationData, Record<string, unknown>>(MenuCreateMutation);
  const update = useAdminMutation<MenuMutationData, Record<string, unknown>>(MenuUpdateMutation);
  const remove = useAdminMutation<MenuMutationData, { id: string }>(MenuDeleteMutation);
  const { problem, attempt } = useAttempt();
  const [title, setTitle] = useState(menu?.title ?? '');
  const [handle, setHandle] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>(() => draftsOf(menu?.items ?? []));
  const [saved, setSaved] = useState(false);
  const [asking, setAsking] = useState(false);
  // When the menu was last saved as this form knows it: a save made since by someone else is
  // refused rather than saved over (ADR-642).
  const [readAt, setReadAt] = useState(menu?.updatedAt ?? null);
  const choices: Choices = {
    collections: (collections.data?.collections.nodes ?? []).map((each) => ({
      value: each.id,
      label: each.title,
    })),
    pages: (pages.data?.pages.nodes ?? []).map((each) => ({ value: each.id, label: each.title })),
    policies: (policies.data?.shop.shopPolicies ?? []).map((each) => ({
      value: each.id,
      label: each.title,
    })),
    tags: tags.data?.productTags ?? [],
  };
  const shownHandle = handle || handleOf(title);
  const ready = title.trim() !== '' && complete(drafts) && (menu !== null || shownHandle !== '');
  const change = (next: (all: Draft[]) => Draft[]) => {
    setSaved(false);
    setDrafts(next);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const result: { id?: string } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        menu
          ? await update.mutateAsync({
              id: menu.id,
              title: title.trim(),
              items: linksInput(drafts),
              ifUnchangedSince: readAt,
            })
          : await create.mutateAsync({
              title: title.trim(),
              handle: shownHandle,
              items: linksInput(drafts),
            }),
      )[0]!;
      result.id = payload.menu?.id;
      if (payload.menu?.updatedAt) setReadAt(payload.menu.updatedAt);
      return {
        ...payload,
        userErrors: payload.userErrors.map((error) =>
          error.code === 'STALE' ? { ...error, field: null, message: t('menus.stale') } : error,
        ),
      };
    });
    if (!ok) return;
    if (menu) setSaved(true);
    else if (result.id) {
      await navigate({
        to: '/$shopId/online-store/menus/$menuId',
        params: { shopId, menuId: result.id },
      });
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('menus.details')}>
        <TextField
          label={t('menus.titleLabel')}
          required
          dir="auto"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {menu ? (
          <p className="text-secondary">
            {t('menus.handleIs')} <span dir="ltr">{menu.handle}</span>
          </p>
        ) : (
          <TextField
            label={t('menus.handle')}
            hint={t('menus.handleHint')}
            ltr
            value={shownHandle}
            onChange={(event) => setHandle(event.target.value)}
          />
        )}
      </FormSection>
      <FormSection title={t('menus.links')} hint={t('menus.linksHint')}>
        {drafts.length === 0 ? (
          <p className="text-secondary">{t('menus.noLinks')}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {drafts.map((draft, index) => (
              <LinkEditor
                key={draft.key}
                draft={draft}
                path={[index]}
                last={index === drafts.length - 1}
                choices={choices}
                change={change}
              />
            ))}
          </ol>
        )}
        <Button
          variant="secondary"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          onClick={() => change((all) => [...all, blank()])}
        >
          {t('menus.addLink')}
        </Button>
      </FormSection>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {saved && <Alert tone="success">{t('menus.saved')}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={create.isPending || update.isPending} disabled={!ready}>
          {t(menu ? 'menus.save' : 'menus.create')}
        </Button>
        {menu && !menu.isDefault && !asking && (
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={() => setAsking(true)}
          >
            {t('menus.delete')}
          </Button>
        )}
      </div>
      {menu && asking && (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <p>{t('menus.deleteAsk', { title: menu.title })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() =>
                void (async () => {
                  const ok = await attempt(
                    async () => Object.values(await remove.mutateAsync({ id: menu.id }))[0]!,
                  );
                  if (ok) {
                    await navigate({
                      to: '/$shopId/online-store',
                      params: { shopId },
                      search: { tab: 'menus' },
                    });
                  }
                })()
              }
            >
              {t('menus.deleteConfirm')}
            </Button>
            <Button variant="tertiary" onClick={() => setAsking(false)}>
              {t('returns.cancel')}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

/**
 * A menu of the shop's (OS-07): its links, to the home page, all products, a collection, a
 * product, a page or a web address, three levels deep, put in order and saved whole; owners and
 * managers. `new` makes one.
 */
export function MenuEditorPage() {
  const { t } = useLocale();
  const shop = useShop();
  const shopId = shop.id;
  const { menuId } = useParams({ from: '/$shopId/online-store/menus/$menuId' });
  const query = useAdminQuery<MenusData>(['menus'], MenusQuery, {}, { enabled: menuId !== 'new' });
  const back = (
    <Link
      to="/$shopId/online-store"
      params={{ shopId }}
      search={{ tab: 'menus' }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('menus.back')}
    </Link>
  );

  if (!permits(shop, EDITS_MENUS)) return <EmptyState title={t('menus.cannot')} />;
  if (menuId === 'new') {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
        {back}
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('menus.add')}
        </h1>
        <MenuForm menu={null} />
      </div>
    );
  }
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const menu = query.data.menus.nodes.find((each) => each.id === menuId) ?? null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {back}
      {!menu ? (
        <EmptyState title={t('menus.notFound')} />
      ) : (
        <>
          <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
            {menu.title}
          </h1>
          <MenuForm key={menu.id} menu={menu} />
          <MenuUrduCard menu={menu} />
        </>
      )}
    </div>
  );
}
