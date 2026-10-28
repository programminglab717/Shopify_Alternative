import { useState } from 'react';
import { SupportAgentQuery, SupportAgentUpdateMutation } from '../api/operations';
import type { SupportAgentData, SupportAgentUpdateData } from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { CheckField } from './settings-form';
import { SETS_SETTINGS } from './settings-page';

/**
 * The AI answering the shop's customers (MSG-07, ADR-849), on WhatsApp and in its web chat: on or
 * off, for owners and managers, with how many it answered today. It answers from the shop's
 * policies and the customer's own orders, and leaves a conversation to staff once they take it.
 */
export function SupportAgentCard() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<SupportAgentData>(['supportAgent'], SupportAgentQuery);
  const update = useAdminMutation<SupportAgentUpdateData, { enabled: boolean }>(
    SupportAgentUpdateMutation,
  );
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
    const agent = query.data.supportAgent;
    const onChange = async (enabled: boolean) => {
      setProblem(null);
      try {
        const { supportAgentUpdate } = await update.mutateAsync({ enabled });
        const error = supportAgentUpdate.userErrors[0];
        if (error) setProblem(problemText(error, t));
      } catch (failure) {
        setProblem(errorText(failure, t));
      }
    };
    body = !agent.available ? (
      <p className="text-secondary">{t('supportAgent.unavailable')}</p>
    ) : (
      <div className="flex flex-col gap-3">
        <CheckField
          label={t('supportAgent.on')}
          checked={agent.enabled}
          onChange={(enabled) => may && !update.isPending && void onChange(enabled)}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('supportAgent.how')}
        </p>
        {agent.enabled && (
          <p className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('supportAgent.today', { count: agent.answeredToday, limit: agent.limitPerDay })}
          </p>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
      </div>
    );
  }
  return (
    <FormSection title={t('supportAgent.title')} hint={t('supportAgent.hint')}>
      {body}
    </FormSection>
  );
}
