import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CollectionAddProductsMutation,
  CollectionDeleteMutation,
  CollectionProductSearchQuery,
  CollectionQuery,
  CollectionRemoveProductsMutation,
  CollectionReorderProductsMutation,
  CollectionUpdateMutation,
} from '../api/operations';
import type {
  CollectionData,
  CollectionMutationData,
  CollectionProductSearchData,
  CollectionRule,
  CollectionSortOrder,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, TextArea } from '../products/product-form';
import { EDITS_PRODUCTS, ProductStatusBadge } from '../products/status';
import { useAttempt } from '../returns/parcel';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CollectionUrduCard } from '../urdu/urdu-pages';
import { BackToProducts } from './collections-page';
import { RulesEditor, ruleInput, rulesComplete, sortOrders } from './collection-form';

type Collection = NonNullable<CollectionData['collection']>;

const sameRules = (a: readonly CollectionRule[], b: readonly CollectionRule[]) =>
  JSON.stringify(a.map(ruleInput)) === JSON.stringify(b.map(ruleInput));

/** The collection's title, description, order and rules, changed by those who change products. */
function Details({ collection, edits }: { collection: Collection; edits: boolean }) {
  const { t } = useLocale();
  const update = useAdminMutation<CollectionMutationData, { input: Record<string, unknown> }>(
    CollectionUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description);
  const [sortOrder, setSortOrder] = useState<CollectionSortOrder>(collection.sortOrder);
  const [rules, setRules] = useState<CollectionRule[]>(collection.ruleSet?.rules ?? []);
  const [any, setAny] = useState(collection.ruleSet?.appliedDisjunctively ?? false);
  const [saved, setSaved] = useState(false);
  const smart = collection.ruleSet !== null;
  const rulesChanged =
    smart &&
    (!sameRules(rules, collection.ruleSet!.rules) ||
      any !== collection.ruleSet!.appliedDisjunctively);
  const input = {
    ...(title.trim() !== collection.title && { title: title.trim() }),
    ...(description.trim() !== collection.description && { description: description.trim() }),
    ...(sortOrder !== collection.sortOrder && { sortOrder }),
    ...(rulesChanged && { ruleSet: { appliedDisjunctively: any, rules: rules.map(ruleInput) } }),
  };
  const changed = Object.keys(input).length > 0;
  const ready = changed && title.trim() !== '' && (!smart || rulesComplete(rules));

  if (!edits) {
    return (
      <FormSection title={t('collection.details')}>
        {collection.description && (
          <p className="whitespace-pre-line" dir="auto">
            {collection.description}
          </p>
        )}
        <p className="text-secondary">
          {t(`collection.sort.${collection.sortOrder}` as MessageKey)}
        </p>
      </FormSection>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaved(false);
    const ok = await attempt(
      async () =>
        Object.values(await update.mutateAsync({ input: { id: collection.id, ...input } }))[0]!,
    );
    setSaved(ok);
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
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
        {smart && (
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
          options={sortOrders(!smart).map((each) => ({
            value: each,
            label: t(`collection.sort.${each}` as MessageKey),
          }))}
          onChange={setSortOrder}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('collection.saved')}</Alert>}
        <Button type="submit" className="self-start" busy={update.isPending} disabled={!ready}>
          {t('collection.save')}
        </Button>
      </FormSection>
    </form>
  );
}

/** Products found by words, added to the end of a collection made by hand. */
function AddProducts({ collection }: { collection: Collection }) {
  const { t } = useLocale();
  const add = useAdminMutation<CollectionMutationData, { id: string; productIds: string[] }>(
    CollectionAddProductsMutation,
  );
  const { problem, attempt } = useAttempt();
  const [words, setWords] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const query = useAdminQuery<CollectionProductSearchData>(
    ['collectionProductSearch', searched],
    CollectionProductSearchQuery,
    { query: searched },
    { enabled: searched !== null },
  );
  const inside = new Set(collection.products.nodes.map((product) => product.id));

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(words.trim());
        }}
      >
        <input
          type="search"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          aria-label={t('collection.findProducts')}
          placeholder={t('collection.findProducts')}
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button type="submit" variant="secondary" icon={<Search aria-hidden className="size-5" />}>
          {t('drafts.find')}
        </Button>
      </form>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {query.data &&
        (query.data.products.nodes.length === 0 ? (
          <p className="text-secondary">{t('drafts.noProducts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
            {query.data.products.nodes.map((product) => (
              <li key={product.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0" dir="auto">
                  {product.title}
                </span>
                {inside.has(product.id) ? (
                  <span className="text-secondary">{t('collection.already')}</span>
                ) : (
                  <Button
                    variant="tertiary"
                    aria-label={t('drafts.add', { title: product.title })}
                    icon={<Plus aria-hidden className="size-5" />}
                    busy={add.isPending && add.variables?.productIds[0] === product.id}
                    onClick={() =>
                      void attempt(
                        async () =>
                          Object.values(
                            await add.mutateAsync({ id: collection.id, productIds: [product.id] }),
                          )[0]!,
                      )
                    }
                  >
                    {t('drafts.addShort')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/**
 * The collection's products in their order: those of one made by hand moved up or down while it
 * is sorted by hand, taken out, and found and added; those of one made by rules as its rules
 * find them.
 */
function Products({ collection, edits }: { collection: Collection; edits: boolean }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const remove = useAdminMutation<CollectionMutationData, { id: string; productIds: string[] }>(
    CollectionRemoveProductsMutation,
  );
  const reorder = useAdminMutation<
    CollectionMutationData,
    { id: string; moves: { id: string; newPosition: number }[] }
  >(CollectionReorderProductsMutation);
  const { problem, attempt } = useAttempt();
  const manual = collection.ruleSet === null;
  const moves = edits && manual && collection.sortOrder === 'MANUAL';
  const products = collection.products.nodes;
  const move = (id: string, newPosition: number) =>
    void attempt(
      async () =>
        Object.values(
          await reorder.mutateAsync({ id: collection.id, moves: [{ id, newPosition }] }),
        )[0]!,
    );

  return (
    <FormSection
      title={t('collection.products', { count: formatCount(collection.productsCount) })}
      hint={manual ? undefined : t('collection.byRulesHint')}
    >
      {products.length === 0 ? (
        <p className="text-secondary">
          {t(manual ? 'collection.emptyHand' : 'collection.emptyRules')}
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-line">
          {products.map((product, index) => (
            <li key={product.id} className="flex items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <Link
                  to="/$shopId/products/$productId"
                  params={{ shopId, productId: product.id }}
                  className="min-w-0 font-medium text-primary hover:underline"
                  dir="auto"
                >
                  {product.title}
                </Link>
                {product.status !== 'ACTIVE' && <ProductStatusBadge status={product.status} />}
              </span>
              {edits && manual && (
                <span className="flex shrink-0 items-center gap-1">
                  {moves && (
                    <>
                      <Button
                        variant="tertiary"
                        aria-label={t('collection.moveUp', { title: product.title })}
                        disabled={index === 0 || reorder.isPending}
                        icon={<ArrowUp aria-hidden className="size-5" />}
                        onClick={() => move(product.id, index)}
                      />
                      <Button
                        variant="tertiary"
                        aria-label={t('collection.moveDown', { title: product.title })}
                        disabled={index === products.length - 1 || reorder.isPending}
                        icon={<ArrowDown aria-hidden className="size-5" />}
                        onClick={() => move(product.id, index + 2)}
                      />
                    </>
                  )}
                  <Button
                    variant="danger"
                    aria-label={t('collection.remove', { title: product.title })}
                    disabled={remove.isPending}
                    icon={<Trash2 aria-hidden className="size-5" />}
                    onClick={() =>
                      void attempt(
                        async () =>
                          Object.values(
                            await remove.mutateAsync({
                              id: collection.id,
                              productIds: [product.id],
                            }),
                          )[0]!,
                      )
                    }
                  />
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {edits && manual && <AddProducts collection={collection} />}
    </FormSection>
  );
}

/** The collection deleted, once asked; its products stay in the catalog. */
function Delete({ collection }: { collection: Collection }) {
  const { t } = useLocale();
  const { id: shopId } = useShop();
  const navigate = useNavigate();
  const remove = useAdminMutation<CollectionMutationData, { input: { id: string } }>(
    CollectionDeleteMutation,
  );
  const { problem, attempt } = useAttempt();
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button
        variant="danger"
        className="self-start"
        icon={<Trash2 aria-hidden className="size-5" />}
        onClick={() => setAsking(true)}
      >
        {t('collection.delete')}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p>{t('collection.deleteAsk', { title: collection.title })}</p>
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          busy={remove.isPending}
          onClick={() =>
            void (async () => {
              const ok = await attempt(
                async () =>
                  Object.values(await remove.mutateAsync({ input: { id: collection.id } }))[0]!,
              );
              if (ok) await navigate({ to: '/$shopId/collections', params: { shopId } });
            })()
          }
        >
          {t('collection.deleteConfirm')}
        </Button>
        <Button variant="tertiary" onClick={() => setAsking(false)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * A collection's page (CAT-03): its details and rules, and its products in their order, changed
 * by owners and managers; every other role reads it.
 */
export function CollectionPage() {
  const { t } = useLocale();
  const shop = useShop();
  const { collectionId } = useParams({ from: '/$shopId/collections/$collectionId' });
  const query = useAdminQuery<CollectionData>(['collection', collectionId], CollectionQuery, {
    id: collectionId,
  });
  const edits = EDITS_PRODUCTS.includes(shop.role);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const collection = query.data.collection;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToProducts to="collections" />
      {!collection ? (
        <EmptyState title={t('collection.notFound')} />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
              {collection.title}
            </h1>
            <p className="text-secondary">
              {t(collection.ruleSet ? 'collections.byRules' : 'collections.byHand')} ·{' '}
              <span dir="ltr">/collections/{collection.handle}</span>
            </p>
          </div>
          <Details key={collection.id} collection={collection} edits={edits} />
          <Products collection={collection} edits={edits} />
          <CollectionUrduCard collectionId={collection.id} />
          {edits && <Delete collection={collection} />}
        </>
      )}
    </div>
  );
}
