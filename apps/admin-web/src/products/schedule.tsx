import { CalendarClock } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ProductSchedulePublishMutation } from '../api/operations';
import type { ProductDetail, ProductSchedulePublishData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime, localInput } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { FormSection, problemText } from './product-form';

/**
 * A draft put on sale by itself at a time ahead (CAT-17, ADR-441), for a drop that goes live at
 * midnight: the time is typed in the phone's own time, as an article's is, and said back in the
 * shop's. Only a draft has the card; set on sale or archived by hand, a product loses its time.
 */
export function ProductSchedule({ product }: { product: ProductDetail }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const schedule = useAdminMutation<
    ProductSchedulePublishData,
    { productId: string; publishAt: string | null }
  >(ProductSchedulePublishMutation);
  const [stored, setStored] = useState(product.publishAt ?? null);
  const [on, setOn] = useState(stored !== null);
  const [at, setAt] = useState(stored ? localInput(stored) : '');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const wanted = on && at ? new Date(at).toISOString() : null;
  // To the minute, as the field shows it.
  const changed = on ? at !== '' && at !== (stored ? localInput(stored) : '') : stored !== null;
  const words = (iso: string) => formatDateTime(iso, timezone, locale);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaved(false);
    try {
      const { productSchedulePublish } = await schedule.mutateAsync({
        productId: product.id,
        publishAt: wanted,
      });
      const error = productSchedulePublish.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else {
        setStored(productSchedulePublish.product?.publishAt ?? null);
        setSaved(true);
      }
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('schedule.title')} hint={t('schedule.hint')}>
      <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
        <CheckField
          label={t('schedule.on')}
          hint={t('schedule.onHint')}
          checked={on}
          onChange={setOn}
        />
        {on && (
          <TextField
            label={t('schedule.at')}
            hint={t('schedule.atHint')}
            type="datetime-local"
            ltr
            required
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed ? (
          <Alert tone="success">
            {stored === null
              ? t('schedule.savedOff')
              : t('schedule.savedOn', { date: words(stored) })}
          </Alert>
        ) : (
          stored !== null &&
          !changed && (
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t('schedule.set', { date: words(stored) })}
            </p>
          )
        )}
        <Button
          type="submit"
          className="self-start"
          busy={schedule.isPending}
          disabled={!changed}
          icon={<CalendarClock aria-hidden className="size-5" />}
        >
          {t('schedule.save')}
        </Button>
      </form>
    </FormSection>
  );
}
