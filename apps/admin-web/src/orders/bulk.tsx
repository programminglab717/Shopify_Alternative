/** Orders tagged or cancelled many at once from the list (ORD-05). */
import { Ban, Tags } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import {
  OrderBulkAddTagsMutation,
  OrderBulkCancelMutation,
  OrderBulkRemoveTagsMutation,
} from '../api/operations';
import type { OrderBulkData, OrderCancelReason, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card } from '../ui/feedback';
import { TextField } from '../ui/field';
import { REASONS } from './order-page';

/** What became of the orders a bulk action was asked of: how many it changed, and why others not. */
export interface BulkOutcome {
  done: number;
  failed: string[];
}

/**
 * The core's refusals, each naming the order it is about by its name: a bulk refusal's field is
 * `["ids", index]`, the index of the order's ID in those sent.
 */
export function refusals(
  errors: readonly UserError[],
  ids: readonly string[],
  names: ReadonlyMap<string, string>,
): string[] {
  return errors.map((error) => {
    const index = error.field?.[0] === 'ids' ? Number(error.field[1]) : NaN;
    const name = Number.isInteger(index) ? names.get(ids[index] ?? '') : undefined;
    return name ? `${name}: ${error.message}` : error.message;
  });
}

/** Runs a bulk mutation, and says what came of it. */
async function outcomeOf(
  run: () => Promise<OrderBulkData>,
  ids: readonly string[],
  names: ReadonlyMap<string, string>,
  failure: (error: unknown) => string,
): Promise<BulkOutcome> {
  try {
    const payload = Object.values(await run())[0]!;
    return { done: payload.orders.length, failed: refusals(payload.userErrors, ids, names) };
  } catch (error) {
    return { done: 0, failed: [failure(error)] };
  }
}

/** Tags added to the orders chosen, or taken off them: a comma between each. */
export function TagsPanel({
  ids,
  names,
  onDone,
}: {
  ids: readonly string[];
  names: ReadonlyMap<string, string>;
  onDone: (outcome: BulkOutcome | null) => void;
}) {
  const { t } = useLocale();
  const add = useAdminMutation<OrderBulkData, { ids: string[]; tags: string[] }>(
    OrderBulkAddTagsMutation,
  );
  const remove = useAdminMutation<OrderBulkData, { ids: string[]; tags: string[] }>(
    OrderBulkRemoveTagsMutation,
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
      <h2 className="font-semibold">{t('bulk.tagsTitle', { count: ids.length })}</h2>
      <TextField
        label={t('bulk.tags')}
        hint={t('bulk.tagsHint')}
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
 * The orders chosen cancelled for one reason, as each is from its page: their items go back into
 * stock and each customer is told; a note goes on each timeline.
 */
export function CancelPanel({
  ids,
  names,
  onDone,
}: {
  ids: readonly string[];
  names: ReadonlyMap<string, string>;
  onDone: (outcome: BulkOutcome | null) => void;
}) {
  const { t } = useLocale();
  const radios = useId();
  const cancel = useAdminMutation<
    OrderBulkData,
    { ids: string[]; reason: OrderCancelReason; staffNote: string | null }
  >(OrderBulkCancelMutation);
  const [reason, setReason] = useState<OrderCancelReason>('CUSTOMER');
  const [note, setNote] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onDone(
      await outcomeOf(
        () => cancel.mutateAsync({ ids: [...ids], reason, staffNote: note.trim() || null }),
        ids,
        names,
        (error) => errorText(error, t),
      ),
    );
  };

  return (
    <Card className="p-4">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <h2 className="font-semibold">{t('bulk.cancelTitle', { count: ids.length })}</h2>
        <p className="text-secondary">{t('bulk.cancelBody')}</p>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t('order.cancelReason')}</legend>
          {REASONS.map((each) => (
            <label key={each} className="flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name={radios}
                checked={reason === each}
                onChange={() => setReason(each)}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              {t(`order.reason.${each}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        <TextField
          label={t('bulk.note')}
          hint={t('bulk.noteHint')}
          dir="auto"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="destructive"
            busy={cancel.isPending}
            icon={<Ban aria-hidden className="size-5" />}
          >
            {t('bulk.cancelSubmit', { count: ids.length })}
          </Button>
          <Button variant="secondary" onClick={() => onDone(null)}>
            {t('bulk.cancelKeep')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
