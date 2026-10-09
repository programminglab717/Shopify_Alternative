import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CollectionCreateMutation, CollectionsQuery } from '../api/operations';
import type {
  CollectionMutationData,
  CollectionRule,
  CollectionSortOrder,
  CollectionsData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, TextArea } from '../products/product-form';
import { EDITS_PRODUCTS } from '../products/status';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { NEW_RULE, RulesEditor, ruleInput, rulesComplete, sortOrders } from './collection-form';

/** Back to the products, which collections group. */
export function BackToProducts({ to = 'products' }: { to?: 'products' | 'collections' }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  return (
    <Link
      to={to === 'products' ? '/$shopId/products' : '/$shopId/collections'}
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t(to === 'products' ? 'collections.back' : 'collection.back')}
    </Link>
  );
}

/**
 * Collections (CAT-03): the shop's collections, found by their titles, each made by hand or by
 * rules with how many products it holds; owners and managers make new ones.
 */
export function CollectionsPage() {
  const { t } = useLocale();
  const shop = useShop();
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const query = useAdminQuery<CollectionsData>(['collections', searched], CollectionsQuery, {
    query: searched || null,
  });
  const edits = EDITS_PRODUCTS.includes(shop.role);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <BackToProducts />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('collections.title')}
        </h1>
        {edits && (
          <Link
            to="/$shopId/collections/new"
            params={{ shopId: shop.id }}
            className="inline-flex min-h-12 items-center gap-2 rounded-control bg-primary px-4 font-medium text-on-primary hover:bg-primary-strong md:min-h-10"
          >
            <Plus aria-hidden className="size-5" />
            {t('collections.add')}
          </Link>
        )}
      </div>
      <form
        role="search"
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(words.trim());
        }}
      >
        <Search
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-secondary"
        />
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          aria-label={t('collections.search')}
          placeholder={t('collections.search')}
          className="min-h-12 w-full rounded-control border border-line bg-surface ps-10 pe-3 md:min-h-10"
        />
      </form>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.collections.nodes.length === 0 ? (
        <Card>
          <EmptyState title={t(searched ? 'collections.noneFound' : 'collections.none')} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {query.data.collections.nodes.map((collection) => (
              <li key={collection.id}>
                <Link
                  to="/$shopId/collections/$collectionId"
                  params={{ shopId: shop.id, collectionId: collection.id }}
                  className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 hover:bg-canvas"
                >
                  <span className="flex flex-col">
                    <span className="font-medium" dir="auto">
                      {collection.title}
                    </span>
                    <span className="text-secondary">
                      {t(collection.ruleSet ? 'collections.byRules' : 'collections.byHand')}
                    </span>
                  </span>
                  <span className="num text-secondary">
                    {t('collections.count', { count: formatCount(collection.productsCount) })}
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

/**
 * A new collection: its title and description, made by hand, its products added once made, or by
 * rules, which the core keeps it to; and the order its products show in.
 */
export function NewCollectionPage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<CollectionMutationData, { input: Record<string, unknown> }>(
    CollectionCreateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [byRules, setByRules] = useState(false);
  const [rules, setRules] = useState<CollectionRule[]>([NEW_RULE]);
  const [any, setAny] = useState(false);
  const [sortOrder, setSortOrder] = useState<CollectionSortOrder>('MANUAL');

  if (!EDITS_PRODUCTS.includes(shop.role)) return <EmptyState title={t('product.cannotEdit')} />;

  const ready = title.trim() !== '' && (!byRules || rulesComplete(rules));
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const made: { id?: string } = {};
    const ok = await attempt(async () => {
      const payload = Object.values(
        await create.mutateAsync({
          input: {
            title: title.trim(),
            ...(description.trim() && { description: description.trim() }),
            sortOrder,
            ...(byRules && {
              ruleSet: { appliedDisjunctively: any, rules: rules.map(ruleInput) },
            }),
          },
        }),
      )[0]!;
      made.id = payload.collection?.id;
      return payload;
    });
    if (ok && made.id) {
      await navigate({
        to: '/$shopId/collections/$collectionId',
        params: { shopId: shop.id, collectionId: made.id },
      });
    }
  };

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="mx-auto flex max-w-3xl flex-col gap-4 pb-8"
    >
      <BackToProducts to="collections" />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('collections.add')}
      </h1>
      <FormSection title={t('collection.details')}>
        <TextField
          label={t('collection.titleLabel')}
          required
          dir="auto"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <TextArea
          label={t('collection.description')}
          value={description}
          onChange={setDescription}
        />
      </FormSection>
      <FormSection title={t('collection.kind')} hint={t('collection.kindHint')}>
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">{t('collection.kind')}</legend>
          {[false, true].map((each) => (
            <label key={String(each)} className="flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name="kind"
                checked={byRules === each}
                onChange={() => {
                  setByRules(each);
                  setSortOrder(each ? 'CREATED_DESC' : 'MANUAL');
                }}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              {t(each ? 'collection.kindRules' : 'collection.kindHand')}
            </label>
          ))}
        </fieldset>
        {byRules && (
          <RulesEditor
            rules={rules}
            any={any}
            onChange={(next, nextAny) => {
              setRules(next);
              setAny(nextAny);
            }}
          />
        )}
        <SelectField
          label={t('collection.sortOrder')}
          value={sortOrder}
          options={sortOrders(!byRules).map((each) => ({
            value: each,
            label: t(`collection.sort.${each}` as MessageKey),
          }))}
          onChange={setSortOrder}
        />
      </FormSection>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button type="submit" className="self-start" busy={create.isPending} disabled={!ready}>
        {t('collections.save')}
      </Button>
    </form>
  );
}
