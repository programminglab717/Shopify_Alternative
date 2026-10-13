import { CalendarClock } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductPreorderSetMutation } from '../api/operations';
import type { ProductDetail, ProductPreorderSetData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, problemText } from './product-form';

/** Today in Pakistan, as YYYY-MM-DD: five hours ahead of UTC, as the core counts it (ADR-403). */
export function pakistanToday(now = new Date(), plusDays = 0): string {
  return new Date(now.getTime() + 5 * 3_600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
}

/** A day, YYYY-MM-DD, in words of the page's language. */
export function shipsOnWords(day: string, locale: Parameters<typeof formatDate>[2]): string {
  return formatDate(`${day}T00:00:00Z`, 'UTC', locale);
}

/**
 * A product's pre-order (CAT-14, ADR-403): on it, the product sells whatever its stock, and says
 * the day it ships by; off it, each variant sells as its own stock rules say. A day gone by is
 * warned of: customers are still told it.
 */
export function ProductPreorder({ product }: { product: ProductDetail }) {
  const { t, locale } = useLocale();
  const set = useAdminMutation<
    ProductPreorderSetData,
    { productId: string; shipsOn: string | null }
  >(ProductPreorderSetMutation);
  const stored = product.preorder?.shipsOn ?? null;
  const [on, setOn] = useState(stored !== null);
  const [day, setDay] = useState(stored ?? pakistanToday(new Date(), 30));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const today = pakistanToday();
  const changed = on ? day !== stored : stored !== null;

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(undefined);
    try {
      const { productPreorderSet } = await set.mutateAsync({
        productId: product.id,
        shipsOn: on ? day : null,
      });
      const error = productPreorderSet.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else setSaved(productPreorderSet.preorder?.shipsOn ?? null);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('preorder.title')} hint={t('preorder.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        {stored !== null && stored < today && (
          <Alert tone="warning">
            {t('preorder.passed', { date: shipsOnWords(stored, locale) })}
          </Alert>
        )}
        <CheckField
          label={t('preorder.on')}
          hint={t('preorder.onHint')}
          checked={on}
          onChange={setOn}
        />
        {on && (
          <TextField
            label={t('preorder.shipsOn')}
            hint={t('preorder.shipsOnHint')}
            type="date"
            ltr
            required
            min={today}
            max={pakistanToday(new Date(), 365)}
            value={day}
            onChange={(event) => setDay(event.target.value)}
          />
        )}
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('preorder.payment')}
        </p>
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved !== undefined && !changed && (
          <Alert tone="success">
            {saved === null
              ? t('preorder.savedOff')
              : t('preorder.savedOn', { date: shipsOnWords(saved, locale) })}
          </Alert>
        )}
        <Button
          type="submit"
          className="self-start"
          busy={set.isPending}
          disabled={!changed}
          icon={<CalendarClock aria-hidden className="size-5" />}
        >
          {t('preorder.save')}
        </Button>
      </form>
    </FormSection>
  );
}
