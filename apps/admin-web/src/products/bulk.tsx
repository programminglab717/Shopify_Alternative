/** Products shown, hidden, tagged, put in a collection or deleted many at once from the list (CAT-04). */
import { FolderPlus, Tags, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CollectionAddProductsMutation,
  CollectionsQuery,
  ProductBulkAddTagsMutation,
  ProductBulkDeleteMutation,
  ProductBulkRemoveTagsMutation,
  ProductBulkUpdateStatusMutation,
} from '../api/operations';
import type {
  CollectionMutationData,
  CollectionsData,
  ProductBulkData,
  ProductStatus,
  UserError,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { BulkOutcome } from '../orders/bulk';
import { refusals } from '../orders/bulk';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card } from '../ui/feedback';
import { TextField } from '../ui/field';
import { PRODUCT_STATUSES } from './status';

/** What each panel is given: the products chosen, their titles, and what to do once done. */
interface PanelProps {
  ids: readonly string[];
  names: ReadonlyMap<string, string>;
  onDone: (outcome: BulkOutcome | null) => void;
}

/** Runs a bulk mutation, and says what came of it: how many done, and each refused by title. */
async function outcomeOf(
  run: () => Promise<ProductBulkData>,
  ids: readonly string[],
  names: ReadonlyMap<string, string>,
  failure: (error: unknown) => string,
): Promise<BulkOutcome> {
  try {
    const payload = Object.values(await run())[0]!;
    const done = payload.products ?? payload.deletedProductIds ?? [];
    return { done: done.length, failed: refusals(payload.userErrors, ids, names) };
  } catch (error) {
    return { done: 0, failed: [failure(error)] };
  }
}

/** The products chosen shown in the store, hidden as drafts, or archived. */
export function StatusPanel({ ids, names, onDone }: PanelProps) {
  const { t } = useLocale();
  const radios = useId();
  const update = useAdminMutation<ProductBulkData, { ids: string[]; status: ProductStatus }>(
    ProductBulkUpdateStatusMutation,
  );
  const [status, setStatus] = useState<ProductStatus>('ACTIVE');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onDone(
      await outcomeOf(
        () => update.mutateAsync({ ids: [...ids], status }),
        ids,
        names,
        (error) => errorText(error, t),
      ),
    );
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('productBulk.statusTitle', { count: ids.length })}</h2>
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">{t('productBulk.status')}</legend>
          {(Object.keys(PRODUCT_STATUSES) as ProductStatus[]).map((each) => (
            <label key={each} className="flex min-h-10 items-start gap-2 py-1">
              <input
                type="radio"
                name={radios}
                checked={status === each}
                onChange={() => setStatus(each)}
                className="mt-0.5 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
              />
              <span className="flex flex-col">
                <span className="font-medium">{t(PRODUCT_STATUSES[each].label)}</span>
                <span className="text-secondary">{t(PRODUCT_STATUSES[each].hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={update.isPending}>
            {t('productBulk.statusSubmit', { count: ids.length })}
          </Button>
          <Button variant="tertiary" onClick={() => onDone(null)}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Tags added to the products chosen, or taken off them: a comma between each. */
export function ProductTagsPanel({ ids, names, onDone }: PanelProps) {
  const { t } = useLocale();
  const add = useAdminMutation<ProductBulkData, { ids: string[]; tags: string[] }>(
    ProductBulkAddTagsMutation,
  );
  const remove = useAdminMutation<ProductBulkData, { ids: string[]; tags: string[] }>(
    ProductBulkRemoveTagsMutation,
  );
  const [words, setWords] = useState('');
  const tags = [
    ...new Set(
      words
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];

  const run = async (mutation: typeof add) =>
    onDone(
      await outcomeOf(
        () => mutation.mutateAsync({ ids: [...ids], tags }),
        ids,
        names,
        (error) => errorText(error, t),
      ),
    );

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">{t('productBulk.tagsTitle', { count: ids.length })}</h2>
      <TextField
        label={t('bulk.tags')}
        hint={t('productBulk.tagsHint')}
        dir="auto"
        maxLength={500}
        value={words}
        onChange={(event) => setWords(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          icon={<Tags aria-hidden className="size-5" />}
          disabled={tags.length === 0 || remove.isPending}
          busy={add.isPending}
          onClick={() => void run(add)}
        >
          {t('bulk.addTags')}
        </Button>
        <Button
          variant="secondary"
          disabled={tags.length === 0 || add.isPending}
          busy={remove.isPending}
          onClick={() => void run(remove)}
        >
          {t('bulk.removeTags')}
        </Button>
        <Button variant="tertiary" onClick={() => onDone(null)}>
          {t('returns.cancel')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * The products chosen put last in a collection made by hand; those it has already stay where they
 * are. A collection with rules takes products by them, so it is not offered.
 */
export function CollectionPanel({ ids, names, onDone }: PanelProps) {
  const { t } = useLocale();
  const collections = useAdminQuery<CollectionsData>(['collections', null], CollectionsQuery, {
    query: null,
  });
  const addTo = useAdminMutation<CollectionMutationData, { id: string; productIds: string[] }>(
    CollectionAddProductsMutation,
  );
  const manual = (collections.data?.collections.nodes ?? []).filter((each) => !each.ruleSet);
  const [chosen, setChosen] = useState('');
  const collection = chosen || manual[0]?.id || '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const data = await addTo.mutateAsync({ id: collection, productIds: [...ids] });
      // The core says a product refused at its place in `productIds`, as a bulk action's `ids`.
      const errors: UserError[] = Object.values(data)[0]!.userErrors.map((error) => ({
        ...error,
        field: error.field?.[0] === 'productIds' ? ['ids', ...error.field.slice(1)] : error.field,
      }));
      onDone({
        done: errors.length > 0 ? 0 : ids.length,
        failed: refusals(errors, ids, names),
      });
    } catch (error) {
      onDone({ done: 0, failed: [errorText(error, t)] });
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('productBulk.collectionTitle', { count: ids.length })}</h2>
        {collections.isPending ? (
          <p className="text-secondary">{t('state.loading')}</p>
        ) : manual.length === 0 ? (
          <p className="text-secondary">{t('productBulk.noCollections')}</p>
        ) : (
          <SelectField
            label={t('productBulk.collection')}
            value={collection}
            options={manual.map((each) => ({ value: each.id, label: each.title }))}
            onChange={setChosen}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            busy={addTo.isPending}
            disabled={!collection}
            icon={<FolderPlus aria-hidden className="size-5" />}
          >
            {t('productBulk.collectionSubmit')}
          </Button>
          <Button variant="tertiary" onClick={() => onDone(null)}>
            {t('returns.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The products chosen deleted for good, with their variants, photos and stock. */
export function DeletePanel({ ids, names, onDone }: PanelProps) {
  const { t } = useLocale();
  const remove = useAdminMutation<ProductBulkData, { ids: string[] }>(ProductBulkDeleteMutation);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onDone(
      await outcomeOf(
        () => remove.mutateAsync({ ids: [...ids] }),
        ids,
        names,
        (error) => errorText(error, t),
      ),
    );
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('productBulk.deleteTitle', { count: ids.length })}</h2>
        <p className="text-secondary">{t('productBulk.deleteBody')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="destructive"
            busy={remove.isPending}
            icon={<Trash2 aria-hidden className="size-5" />}
          >
            {t('productBulk.deleteSubmit', { count: ids.length })}
          </Button>
          <Button variant="secondary" onClick={() => onDone(null)}>
            {t('bulk.cancelKeep')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
