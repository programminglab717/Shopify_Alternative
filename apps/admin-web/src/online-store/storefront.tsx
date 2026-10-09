import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { StorefrontPreferencesQuery, StorefrontPreferencesUpdateMutation } from '../api/operations';
import type {
  StorefrontPreferences,
  StorefrontPreferencesData,
  StorefrontPreferencesUpdateData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { localInput } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

type Input = Record<string, unknown>;

/**
 * One part of the storefront's preferences: its fields, and a Save that sends those changed. It
 * says "Saved." once what it shows is what the core keeps.
 */
function PreferencesForm({
  title,
  hint,
  input,
  ready = true,
  children,
}: {
  title: string;
  hint?: string;
  input: Input;
  ready?: boolean;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const update = useAdminMutation<StorefrontPreferencesUpdateData, { input: Input }>(
    StorefrontPreferencesUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [saved, setSaved] = useState(false);
  const changed = Object.keys(input).length > 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !ready) return;
    setSaved(false);
    const ok = await attempt(
      async () => (await update.mutateAsync({ input })).onlineStorePreferencesUpdate,
    );
    if (ok) setSaved(true);
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormSection title={title} hint={hint}>
        {children}
        {problem && <Alert tone="danger">{problem}</Alert>}
        {saved && !changed && <Alert tone="success">{t('storefront.saved')}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={update.isPending}
          disabled={!changed || !ready}
        >
          {t('storefront.save')}
        </Button>
      </FormSection>
    </form>
  );
}

/** The storefront closed behind a password while the shop gets ready to open (OS-15). */
function PasswordForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState(preferences.passwordEnabled);
  const [password, setPassword] = useState(preferences.password ?? '');
  const [message, setMessage] = useState(preferences.passwordMessage);
  const input = {
    ...(enabled !== preferences.passwordEnabled && { passwordEnabled: enabled }),
    ...(password.trim() !== (preferences.password ?? '') && { password: password.trim() }),
    ...(message.trim() !== preferences.passwordMessage && { passwordMessage: message.trim() }),
  };
  return (
    <PreferencesForm
      title={t('storefront.password')}
      hint={t('storefront.passwordHint')}
      input={input}
      ready={!enabled || password.trim() !== ''}
    >
      <CheckField
        label={t('storefront.passwordEnabled')}
        hint={t(enabled ? 'storefront.passwordOn' : 'storefront.passwordOff')}
        checked={enabled}
        onChange={setEnabled}
      />
      <TextField
        label={t('storefront.passwordLabel')}
        hint={t('storefront.passwordLabelHint')}
        ltr
        autoComplete="off"
        required={enabled}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <TextField
        label={t('storefront.passwordMessage')}
        hint={t('storefront.passwordMessageHint')}
        dir="auto"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
    </PreferencesForm>
  );
}

/** The open storefront paused for a while, opening again by itself at a time or when told. */
function PauseForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState(preferences.maintenanceEnabled);
  const [message, setMessage] = useState(preferences.maintenanceMessage);
  const kept = preferences.maintenanceUntil ? localInput(preferences.maintenanceUntil) : '';
  const [until, setUntil] = useState(kept);
  const input = {
    ...(enabled !== preferences.maintenanceEnabled && { maintenanceEnabled: enabled }),
    ...(message.trim() !== preferences.maintenanceMessage && {
      maintenanceMessage: message.trim(),
    }),
    ...(enabled &&
      until !== kept && { maintenanceUntil: until ? new Date(until).toISOString() : null }),
  };
  return (
    <PreferencesForm title={t('storefront.pause')} hint={t('storefront.pauseHint')} input={input}>
      <CheckField
        label={t('storefront.pauseEnabled')}
        hint={t(enabled ? 'storefront.pauseOn' : 'storefront.pauseOff')}
        checked={enabled}
        onChange={setEnabled}
      />
      <TextField
        label={t('storefront.pauseMessage')}
        hint={t('storefront.pauseMessageHint')}
        dir="auto"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      {enabled && (
        <TextField
          label={t('storefront.pauseUntil')}
          hint={t('storefront.pauseUntilHint')}
          type="datetime-local"
          ltr
          value={until}
          onChange={(event) => setUntil(event.target.value)}
        />
      )}
    </PreferencesForm>
  );
}

/** The home page's title and description, as search engines and shared links show them. */
function SearchForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const [title, setTitle] = useState(preferences.seo.title ?? '');
  const [description, setDescription] = useState(preferences.seo.description ?? '');
  const changed =
    title.trim() !== (preferences.seo.title ?? '') ||
    description.trim() !== (preferences.seo.description ?? '');
  const input = changed ? { seo: { title: title.trim(), description: description.trim() } } : {};
  return (
    <PreferencesForm title={t('storefront.search')} hint={t('storefront.searchHint')} input={input}>
      <TextField
        label={t('storefront.searchTitle')}
        hint={t('storefront.searchTitleHint', { count: title.trim().length })}
        dir="auto"
        maxLength={70}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <TextField
        label={t('storefront.searchDescription')}
        hint={t('storefront.searchDescriptionHint', { count: description.trim().length })}
        dir="auto"
        maxLength={320}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
    </PreferencesForm>
  );
}

/**
 * The storefront's preferences (OS-09, OS-15), for owners and managers: its password while the
 * shop gets ready, a pause while it is open, and its home page for search engines.
 */
export function StorefrontPreferencesTab() {
  const { t } = useLocale();
  const query = useAdminQuery<StorefrontPreferencesData>(
    ['storefront-preferences'],
    StorefrontPreferencesQuery,
  );
  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const preferences = query.data.onlineStorePreferences;
  return (
    <div className="flex flex-col gap-4">
      <PasswordForm preferences={preferences} />
      <PauseForm preferences={preferences} />
      <SearchForm preferences={preferences} />
    </div>
  );
}
