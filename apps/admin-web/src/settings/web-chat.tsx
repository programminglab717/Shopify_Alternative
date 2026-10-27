import { useState } from 'react';
import type { FormEvent } from 'react';
import { WebChatSettingsQuery, WebChatSettingsUpdateMutation } from '../api/operations';
import type { WebChatSettingsData, WebChatSettingsUpdateData } from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField } from './settings-form';
import { SETS_SETTINGS } from './settings-page';

/** What the chat may say before the shopper writes (ADR-810). */
const GREETING_MAX = 200;

/**
 * The chat on the shop's online store (MSG-10, ADR-812): on or off, and what it says before the
 * shopper writes, for owners and managers; chats come to the inbox beside WhatsApp's.
 */
export function WebChatCard() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<WebChatSettingsData>(['webChatSettings'], WebChatSettingsQuery);
  const update = useAdminMutation<WebChatSettingsUpdateData, { input: object }>(
    WebChatSettingsUpdateMutation,
  );
  const [draft, setDraft] = useState<{ enabled: boolean; greeting: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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
    const kept = query.data.webChatSettings;
    const current = draft ?? { enabled: kept.enabled, greeting: kept.greeting ?? '' };
    const changed =
      current.enabled !== kept.enabled || current.greeting.trim() !== (kept.greeting ?? '');
    const onSubmit = async (event: FormEvent) => {
      event.preventDefault();
      if (!changed) return;
      setProblem(null);
      setSaved(false);
      try {
        const { webChatSettingsUpdate } = await update.mutateAsync({
          input: { enabled: current.enabled, greeting: current.greeting.trim() || null },
        });
        const error = webChatSettingsUpdate.userErrors[0];
        if (error) {
          setProblem(problemText(error, t));
          return;
        }
        setDraft(null);
        setSaved(true);
      } catch (failure) {
        setProblem(errorText(failure, t));
      }
    };
    body = (
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <CheckField
          label={t('webChat.on')}
          checked={current.enabled}
          onChange={(enabled) => may && setDraft({ ...current, enabled })}
        />
        <TextField
          label={t('webChat.greeting')}
          hint={t('webChat.greetingHint', { max: GREETING_MAX })}
          value={current.greeting}
          maxLength={GREETING_MAX}
          readOnly={!may}
          onChange={(event) => setDraft({ ...current, greeting: event.target.value })}
        />
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('webChat.saved')}</Alert>}
        {may && (
          <Button type="submit" className="self-start" busy={update.isPending} disabled={!changed}>
            {t('webChat.save')}
          </Button>
        )}
      </form>
    );
  }
  return (
    <FormSection title={t('webChat.title')} hint={t('webChat.hint')}>
      {body}
    </FormSection>
  );
}
