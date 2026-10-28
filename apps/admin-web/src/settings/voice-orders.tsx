import { useState } from 'react';
import { VoiceOrdersQuery, VoiceOrdersSetMutation } from '../api/operations';
import type { VoiceOrdersData, VoiceOrdersSetData } from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { CheckField } from './settings-form';
import { SETS_SETTINGS } from './settings-page';

/**
 * Voice-note orders (MSG-11, ADR-871): customers' WhatsApp voice notes heard, read into what they
 * order and answered with the shop's checkout holding it, on or off for owners and managers. Staff
 * read what was heard in the inbox.
 */
export function VoiceOrdersCard() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<VoiceOrdersData>(['voiceOrders'], VoiceOrdersQuery);
  const set = useAdminMutation<VoiceOrdersSetData, { enabled: boolean }>(VoiceOrdersSetMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const may = permits(shop, SETS_SETTINGS);

  let body;
  if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    const voice = query.data.voiceOrders;
    const onChange = async (enabled: boolean) => {
      setProblem(null);
      try {
        await set.mutateAsync({ enabled });
      } catch (failure) {
        setProblem(errorText(failure, t));
      }
    };
    body = !voice.available ? (
      <p className="text-secondary">{t('voiceOrders.unavailable')}</p>
    ) : (
      <div className="flex flex-col gap-3">
        <CheckField
          label={t('voiceOrders.on')}
          checked={voice.enabled}
          onChange={(enabled) => may && !set.isPending && void onChange(enabled)}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('voiceOrders.how')}
        </p>
        {voice.enabled && (
          <p className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('voiceOrders.today', { count: voice.usedToday, limit: voice.limitPerDay })}
          </p>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
      </div>
    );
  }
  return (
    <FormSection title={t('voiceOrders.title')} hint={t('voiceOrders.hint')}>
      {body}
    </FormSection>
  );
}
