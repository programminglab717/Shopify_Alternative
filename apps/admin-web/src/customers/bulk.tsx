/** Customers tagged many at once from the list (CUS-01). */
import { Tags } from 'lucide-react';
import { useState } from 'react';
import { CustomerBulkAddTagsMutation, CustomerBulkRemoveTagsMutation } from '../api/operations';
import type { CustomerBulkData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { BulkOutcome } from '../orders/bulk';
import { refusals } from '../orders/bulk';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card } from '../ui/feedback';
import { TextField } from '../ui/field';

/**
 * Tags added to the customers chosen, or taken off them: a comma between each. Their marketing
 * consent is not changed here, as each customer gives or withdraws their own (CUS-04).
 */
export function CustomerTagsPanel({
  ids,
  names,
  onDone,
}: {
  ids: readonly string[];
  names: ReadonlyMap<string, string>;
  onDone: (outcome: BulkOutcome | null) => void;
}) {
  const { t } = useLocale();
  const add = useAdminMutation<CustomerBulkData, { ids: string[]; tags: string[] }>(
    CustomerBulkAddTagsMutation,
  );
  const remove = useAdminMutation<CustomerBulkData, { ids: string[]; tags: string[] }>(
    CustomerBulkRemoveTagsMutation,
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

  const run = async (mutation: typeof add) => {
    try {
      const payload = Object.values(await mutation.mutateAsync({ ids: [...ids], tags }))[0]!;
      onDone({
        done: payload.customers.length,
        failed: refusals(payload.userErrors, ids, names),
      });
    } catch (error) {
      onDone({ done: 0, failed: [errorText(error, t)] });
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-semibold">{t('customerBulk.tagsTitle', { count: ids.length })}</h2>
      <TextField
        label={t('bulk.tags')}
        hint={t('customerBulk.tagsHint')}
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
