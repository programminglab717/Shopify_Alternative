import { Search, X } from 'lucide-react';
import { useState } from 'react';
import { CollectionProductSearchQuery, CollectionsQuery } from '../api/operations';
import type { CollectionProductSearchData, CollectionsData } from '../api/types';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';

/** A product or collection a discount is for, by its ID and as staff know it. */
export interface Named {
  id: string;
  title: string;
}

/** The products and collections a discount is for (ADR-517); null for the whole order. */
export type ChosenItems = { products: Named[]; collections: Named[] } | null;

/** What a discount's input says of them: nothing for the whole order. */
export function itemInput(chosen: ChosenItems): {
  productIds?: string[];
  collectionIds?: string[];
} {
  if (chosen === null) return {};
  return {
    productIds: chosen.products.map((product) => product.id),
    collectionIds: chosen.collections.map((collection) => collection.id),
  };
}

/** Whether some items are meant but none chosen yet. */
export function noneChosen(chosen: ChosenItems): boolean {
  return chosen !== null && chosen.products.length === 0 && chosen.collections.length === 0;
}

/** Products found by name, to add one. */
function ProductFinder({
  chosen,
  onAdd,
}: {
  chosen: readonly Named[];
  onAdd: (product: Named) => void;
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
  const found = query.data?.products.nodes.filter(
    (product) => !chosen.some((each) => each.id === product.id),
  );
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
          aria-label={t('appliesTo.findProduct')}
          placeholder={t('appliesTo.findProduct')}
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3 md:min-h-10"
        />
        <Button variant="secondary" icon={<Search aria-hidden className="size-5" />} onClick={find}>
          {t('drafts.find')}
        </Button>
      </div>
      {found && (
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
          {found.length === 0 && (
            <li className="px-3 py-2 text-secondary">{t('drafts.noProducts')}</li>
          )}
          {found.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                className="flex min-h-10 w-full items-center px-3 text-start hover:bg-canvas"
                onClick={() => onAdd({ id: product.id, title: product.title })}
              >
                <span dir="auto">{t('appliesTo.add', { title: product.title })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One chosen product or collection, taken off with its button. */
function Chosen({ item, onRemove }: { item: Named; onRemove: () => void }) {
  const { t } = useLocale();
  return (
    <li className="flex items-center gap-1 rounded-full border border-line ps-3">
      <span dir="auto">{item.title}</span>
      <button
        type="button"
        aria-label={t('appliesTo.remove', { title: item.title })}
        className="grid size-10 place-items-center rounded-full hover:bg-canvas"
        onClick={onRemove}
      >
        <X aria-hidden className="size-4" />
      </button>
    </li>
  );
}

/**
 * Whether a discount is for the whole order or for some products and collections (ADR-517):
 * products found by name, collections chosen from the shop's.
 */
export function AppliesTo({
  value,
  onChange,
}: {
  value: ChosenItems;
  onChange: (value: ChosenItems) => void;
}) {
  const { t } = useLocale();
  const collections = useAdminQuery<CollectionsData>(
    ['collections', null],
    CollectionsQuery,
    { query: null },
    { enabled: value !== null },
  );
  const offered = (collections.data?.collections.nodes ?? []).filter(
    (collection) => !value?.collections.some((each) => each.id === collection.id),
  );

  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label={t('appliesTo.label')}
        value={value === null ? 'ORDER' : 'SOME'}
        options={[
          { value: 'ORDER', label: t('appliesTo.order') },
          { value: 'SOME', label: t('appliesTo.some') },
        ]}
        onChange={(next) => onChange(next === 'ORDER' ? null : { products: [], collections: [] })}
      />
      {value !== null && (
        <div className="flex flex-col gap-3 rounded-control border border-line p-3">
          <p className="text-secondary">{t('appliesTo.hint')}</p>
          {(value.products.length > 0 || value.collections.length > 0) && (
            <ul className="flex flex-wrap gap-2" aria-label={t('appliesTo.chosen')}>
              {value.products.map((product) => (
                <Chosen
                  key={product.id}
                  item={product}
                  onRemove={() =>
                    onChange({
                      ...value,
                      products: value.products.filter((each) => each.id !== product.id),
                    })
                  }
                />
              ))}
              {value.collections.map((collection) => (
                <Chosen
                  key={collection.id}
                  item={{
                    id: collection.id,
                    title: t('appliesTo.collection', { title: collection.title }),
                  }}
                  onRemove={() =>
                    onChange({
                      ...value,
                      collections: value.collections.filter((each) => each.id !== collection.id),
                    })
                  }
                />
              ))}
            </ul>
          )}
          <ProductFinder
            chosen={value.products}
            onAdd={(product) => onChange({ ...value, products: [...value.products, product] })}
          />
          {offered.length > 0 && (
            <SelectField
              label={t('appliesTo.addCollection')}
              value=""
              options={[
                { value: '', label: t('appliesTo.pickCollection') },
                ...offered.map((collection) => ({ value: collection.id, label: collection.title })),
              ]}
              onChange={(id) => {
                const collection = offered.find((each) => each.id === id);
                if (collection) {
                  onChange({
                    ...value,
                    collections: [...value.collections, { id, title: collection.title }],
                  });
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
