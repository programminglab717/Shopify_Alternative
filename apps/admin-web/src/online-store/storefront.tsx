import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  RobotsTxtTestQuery,
  StorefrontPreferencesQuery,
  StorefrontPreferencesUpdateMutation,
} from '../api/operations';
import type {
  RobotsTxtTestData,
  StorefrontPreferences,
  StorefrontPreferencesData,
  StorefrontPreferencesUpdateData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { localInput } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useAttempt } from '../returns/parcel';
import { CheckField, SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { HomeUrduCard } from '../urdu/urdu-pages';

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

/**
 * The open storefront paused for a while, opening again by itself at a time or when told; or
 * checkout alone, the storefront left open to browse (ADR-603).
 */
function PauseForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState(preferences.maintenanceEnabled);
  const keptBrowsing = preferences.maintenanceCheckoutOnly ?? false;
  const [browsing, setBrowsing] = useState(keptBrowsing);
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
    ...(browsing !== keptBrowsing && { maintenanceCheckoutOnly: browsing }),
  };
  return (
    <PreferencesForm title={t('storefront.pause')} hint={t('storefront.pauseHint')} input={input}>
      <CheckField
        label={t('storefront.pauseEnabled')}
        hint={t(
          !enabled
            ? 'storefront.pauseOff'
            : browsing
              ? 'storefront.pauseCheckoutOn'
              : 'storefront.pauseOn',
        )}
        checked={enabled}
        onChange={setEnabled}
      />
      <CheckField
        label={t('storefront.pauseBrowsing')}
        hint={t('storefront.pauseBrowsingHint')}
        checked={browsing}
        onChange={setBrowsing}
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
 * The return window each product page states and tells search engines (OS-11, ADR-468): empty
 * says nothing, 0 says no returns, and the rest a number of days, for an exchange or the money.
 */
function ReturnsForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const kept = preferences.returnDays === null ? '' : String(preferences.returnDays);
  const [days, setDays] = useState(kept);
  const [exchangesOnly, setExchangesOnly] = useState(preferences.returnExchangesOnly);
  const typed = days.trim();
  const valid = typed === '' || (/^\d{1,2}$/.test(typed) && Number(typed) <= 90);
  const input = {
    ...(typed !== kept && { returnDays: typed === '' ? null : Number(typed) }),
    ...(exchangesOnly !== preferences.returnExchangesOnly && {
      returnExchangesOnly: exchangesOnly,
    }),
  };
  return (
    <PreferencesForm
      title={t('storefront.returns')}
      hint={t('storefront.returnsHint')}
      input={input}
      ready={valid}
    >
      <TextField
        label={t('storefront.returnDays')}
        hint={t(valid ? 'storefront.returnDaysHint' : 'storefront.returnDaysInvalid')}
        ltr
        inputMode="numeric"
        value={days}
        onChange={(event) => setDays(event.target.value)}
      />
      {typed !== '0' && (
        <CheckField
          label={t('storefront.returnExchangesOnly')}
          hint={t(exchangesOnly ? 'storefront.returnExchangesOn' : 'storefront.returnExchangesOff')}
          checked={exchangesOnly}
          onChange={setExchangesOnly}
        />
      )}
    </PreferencesForm>
  );
}

/**
 * "Powered by Hatti" at the foot of the storefront (ADR-526, ADR-527): shown unless the shop hides
 * it, which plans from Starter allow; the core says so when the plan doesn't.
 */
function BrandingForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const [shown, setShown] = useState(!preferences.hidePoweredBy);
  const input = shown === !preferences.hidePoweredBy ? {} : { hidePoweredBy: !shown };
  return (
    <PreferencesForm
      title={t('storefront.branding')}
      hint={t('storefront.brandingHint')}
      input={input}
    >
      <CheckField
        label={t('storefront.poweredBy')}
        hint={t(shown ? 'storefront.poweredByOn' : 'storefront.poweredByOff')}
        checked={shown}
        onChange={setShown}
      />
    </PreferencesForm>
  );
}

/**
 * Asking shoppers before the ad platforms' pixels load (ADR-551, ADR-552): a banner on the
 * storefront until they accept or decline, the pixels waiting for the answer.
 */
function ConsentForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const [asks, setAsks] = useState(preferences.consentBanner);
  const input = asks === preferences.consentBanner ? {} : { consentBanner: asks };
  return (
    <PreferencesForm
      title={t('storefront.consent')}
      hint={t('storefront.consentHint')}
      input={input}
    >
      <CheckField
        label={t('storefront.consentBanner')}
        hint={t(asks ? 'storefront.consentOn' : 'storefront.consentOff')}
        checked={asks}
        onChange={setAsks}
      />
    </PreferencesForm>
  );
}

/** The ages a shop's age gate may ask for (ADR-889), the most common first. */
const GATE_AGES = [18, 21, 13, 16, 25] as const;

/**
 * An age gate (OS-15, ADR-889): visitors confirm they are old enough before the storefront shows,
 * not asked again for a month.
 */
function AgeGateForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const saved = preferences.ageGateMinimum ?? 0;
  const [age, setAge] = useState(String(saved));
  const input = Number(age) === saved ? {} : { ageGateMinimum: Number(age) };
  return (
    <PreferencesForm
      title={t('storefront.ageGate')}
      hint={t('storefront.ageGateHint')}
      input={input}
    >
      <SelectField
        label={t('storefront.ageGateAge')}
        value={age}
        options={[
          { value: '0', label: t('storefront.ageGateNone') },
          ...GATE_AGES.map((each) => ({
            value: String(each),
            label: t('storefront.ageGateAt', { age: each }),
          })),
        ]}
        onChange={setAge}
      />
    </PreferencesForm>
  );
}

/**
 * Rules the shop adds to its robots.txt (ADR-055), and a tester (ADR-616): an address and a
 * crawler tried against the robots.txt the storefront would serve with the rules as written, saved
 * or not, saying whether the crawler may fetch it and the rule that decided.
 */
function RobotsForm({ preferences }: { preferences: StorefrontPreferences }) {
  const { t } = useLocale();
  const id = useId();
  const saved = preferences.robotsTxtRules ?? '';
  const [rules, setRules] = useState(saved);
  const [path, setPath] = useState('');
  const [crawler, setCrawler] = useState('Googlebot');
  const [asked, setAsked] = useState<Record<string, unknown> | null>(null);
  const tested = useAdminQuery<RobotsTxtTestData>(
    ['robots-txt-test'],
    RobotsTxtTestQuery,
    asked ?? {},
    {
      enabled: asked !== null,
    },
  );
  const input = rules.trim() === saved ? {} : { robotsTxtRules: rules.trim() };
  const verdict = asked && tested.data?.robotsTxtTest;
  const test = () =>
    setAsked({
      path: path.trim(),
      userAgent: crawler.trim() || null,
      ...(rules.trim() === saved ? {} : { robotsTxtRules: rules }),
    });
  return (
    <PreferencesForm title={t('storefront.robots')} hint={t('storefront.robotsHint')} input={input}>
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="font-medium">
          {t('storefront.robotsRules')}
        </label>
        <textarea
          id={id}
          value={rules}
          rows={6}
          dir="ltr"
          spellCheck={false}
          placeholder={'Disallow: /collections/sale\n\nUser-agent: GPTBot\nDisallow: /'}
          onChange={(event) => setRules(event.target.value)}
          className="rounded-control border border-line bg-surface px-3 py-2 font-mono text-text"
        />
      </div>
      <div className="flex flex-col gap-3 rounded-control border border-line p-3">
        <p className="font-medium">{t('storefront.robotsTest')}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label={t('storefront.robotsPath')}
            ltr
            placeholder="/products/lawn-suit"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <TextField
            label={t('storefront.robotsCrawler')}
            ltr
            value={crawler}
            onChange={(event) => setCrawler(event.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          className="self-start"
          disabled={path.trim() === ''}
          busy={asked !== null && tested.isFetching}
          onClick={test}
        >
          {t('storefront.robotsTry')}
        </Button>
        {verdict && verdict.allowed !== null && (
          <Alert tone={verdict.allowed ? 'success' : 'warning'}>
            {t(verdict.allowed ? 'storefront.robotsAllowed' : 'storefront.robotsBlocked', {
              crawler:
                verdict.userAgent === '*' ? crawler.trim() || 'Googlebot' : verdict.userAgent,
            })}
            {verdict.rule && (
              <>
                {' '}
                {t('storefront.robotsRule')} <code dir="ltr">{verdict.rule}</code>
              </>
            )}
          </Alert>
        )}
        {verdict &&
          verdict.problems.map((problem) => (
            <Alert key={problem} tone="danger">
              {problem}
            </Alert>
          ))}
      </div>
    </PreferencesForm>
  );
}

/**
 * The storefront's preferences (OS-09, OS-11, OS-15), for owners and managers: its password while
 * the shop gets ready, a pause while it is open, its home page for search engines, its return
 * window, whether it says "Powered by Hatti", and whether it asks shoppers before its pixels load.
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
      <RobotsForm preferences={preferences} />
      <ReturnsForm preferences={preferences} />
      <BrandingForm preferences={preferences} />
      <ConsentForm preferences={preferences} />
      <AgeGateForm preferences={preferences} />
      <HomeUrduCard />
    </div>
  );
}
