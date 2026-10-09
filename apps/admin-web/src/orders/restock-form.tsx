import { useState } from 'react';
import type { FormEvent } from 'react';
import { formatCount } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A line of what came back: its order line, and how many of it are in hand. */
export interface RestockLine {
  id: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
}

/** How many of each line go back in stock, as the core takes them; the rest are written off. */
export type Restock = { lineItemId: string; quantity: number }[];

/**
 * What came back checked in (ADR-071, ADR-136): how many of each line go back in stock, all of
 * them to begin with, saying how many will be written off as damaged; more than came back is
 * refused before it is sent.
 */
export function RestockForm({
  lines,
  busy,
  problem,
  onSubmit,
  onCancel,
}: {
  lines: RestockLine[];
  busy: boolean;
  problem: string | null;
  onSubmit: (restock: Restock) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [counts, setCounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, String(line.quantity)])),
  );
  const restock = lines.map((line) => ({
    lineItemId: line.id,
    quantity: /^\d+$/.test(counts[line.id] ?? '') ? Number(counts[line.id]) : Number.NaN,
    most: line.quantity,
  }));
  const valid = restock.every((each) => each.quantity >= 0 && each.quantity <= each.most);
  const writtenOff = valid ? restock.reduce((sum, each) => sum + each.most - each.quantity, 0) : 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) onSubmit(restock.map(({ lineItemId, quantity }) => ({ lineItemId, quantity })));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-secondary">{t('parcels.checkIn.hint')}</p>
      <ul className="flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.id} className="flex items-end gap-3">
            <span className="flex min-w-0 flex-1 flex-col pb-3">
              <span dir="auto">{line.title}</span>
              {line.variantTitle && line.variantTitle !== 'Default Title' && (
                <span className="text-secondary" dir="auto">
                  {line.variantTitle}
                </span>
              )}
            </span>
            <TextField
              label={t('parcels.checkIn.back', { count: formatCount(line.quantity) })}
              inputMode="numeric"
              ltr
              className="w-36"
              value={counts[line.id] ?? ''}
              onChange={(event) => setCounts({ ...counts, [line.id]: event.target.value.trim() })}
            />
          </li>
        ))}
      </ul>
      {!valid && <Alert tone="danger">{t('parcels.checkIn.wrong')}</Alert>}
      {writtenOff > 0 && (
        <Alert tone="warning">
          {t('parcels.checkIn.writtenOff', { count: formatCount(writtenOff) })}
        </Alert>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy} disabled={!valid}>
          {t('parcels.checkIn.save')}
        </Button>
        <Button variant="tertiary" onClick={onCancel}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}
