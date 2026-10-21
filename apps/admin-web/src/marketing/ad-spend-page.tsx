import { Banknote, CloudDownload, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { AdSpendEntriesQuery, AdSpendSetMutation } from '../api/operations';
import type {
  AdSpendEntriesData,
  AdSpendEntryValue,
  AdSpendInput,
  AdSpendPlatform,
  AdSpendSetData,
  AdSpendSource,
  UserError,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText, userErrorText } from '../i18n/errors';
import { formatDate, formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { SETS_META } from '../online-store/meta';
import { FormSection } from '../products/product-form';
import { Problems, SelectField, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { MetaAdAccountSection } from './meta-ad-account';
import { GoogleAdsAccountSection } from './google-ads-account';
import { BackToMarketing } from './templates-page';
import { TikTokAdAccountSection } from './tiktok-ad-account';

const PLATFORMS: readonly AdSpendPlatform[] = ['META', 'TIKTOK', 'GOOGLE', 'OTHER'];

/** What typing over a platform's pulled spend does, for the platforms whose spend is pulled. */
const TYPED: Partial<Record<AdSpendPlatform, MessageKey>> = {
  META: 'adSpend.metaTyped',
  TIKTOK: 'adSpend.tiktokTyped',
  GOOGLE: 'adSpend.googleTyped',
};

/** Where a day's spend was pulled from, for the spend not typed. */
const PULLED_FROM: Partial<Record<AdSpendSource, MessageKey>> = {
  META: 'adSpend.fromMeta',
  TIKTOK: 'adSpend.fromTiktok',
  GOOGLE: 'adSpend.fromGoogle',
};

/** The days the page lists, today's included. */
const DAYS = 30;

/** The form's fields, as the API names them in its problems. */
const LABELS: Partial<Record<string, MessageKey>> = {
  platform: 'adSpend.platform',
  day: 'adSpend.day',
  campaign: 'adSpend.campaign',
  amount: 'adSpend.amount',
};
type Field = 'day' | 'campaign' | 'amount';
const FIELDS: readonly Field[] = ['day', 'campaign', 'amount'];

/** The day `daysAgo` days before today in `timeZone`, as YYYY-MM-DD. */
export function dayIn(timeZone: string, daysAgo = 0, now = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** A day, YYYY-MM-DD, in words of the page's language. */
function useDay() {
  const { locale } = useLocale();
  return (day: string) => formatDate(`${day}T12:00:00Z`, 'UTC', locale);
}

/**
 * Recording a day's spend on one platform, or on one campaign of it: it replaces what that day
 * had. Problems with a field are shown under it; any other above the button.
 */
function RecordSpend() {
  const { t } = useLocale();
  const day = useDay();
  const timezone = useShopTimezone();
  const set = useAdminMutation<AdSpendSetData, { entries: AdSpendInput[] }>(AdSpendSetMutation);
  const [platform, setPlatform] = useState<AdSpendPlatform>('META');
  const [on, setOn] = useState(() => dayIn(timezone));
  const [campaign, setCampaign] = useState('');
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const typed = TYPED[platform];

  const onProblems = (userErrors: UserError[]) => {
    const fields: Partial<Record<Field, string>> = {};
    const others: string[] = [];
    for (const error of userErrors) {
      const field = error.field?.at(-1) as Field | undefined;
      if (field && FIELDS.includes(field)) fields[field] = userErrorText(error, t);
      else others.push(settingProblem(error, t, LABELS));
    }
    setErrors(fields);
    setProblems(others);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!amount.trim()) return;
    setErrors({});
    setProblems([]);
    setSaved(null);
    try {
      const { adSpendSet } = await set.mutateAsync({
        entries: [{ platform, day: on, campaign: campaign.trim() || null, amount: amount.trim() }],
      });
      if (adSpendSet.userErrors.length > 0) {
        onProblems(adSpendSet.userErrors);
        return;
      }
      setSaved(
        t('adSpend.saved', {
          amount: formatMoney(amount.trim()),
          platform: t(`adSpend.platform.${platform}` as MessageKey),
          day: day(on),
        }),
      );
      setAmount('');
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <FormSection title={t('adSpend.record')} hint={t('adSpend.recordHint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <SelectField<AdSpendPlatform>
            label={t('adSpend.platform')}
            value={platform}
            options={PLATFORMS.map((each) => ({
              value: each,
              label: t(`adSpend.platform.${each}` as MessageKey),
            }))}
            onChange={setPlatform}
          />
          {typed && (
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t(typed)}
            </p>
          )}
        </div>
        <TextField
          label={t('adSpend.day')}
          type="date"
          ltr
          required
          max={dayIn(timezone)}
          value={on}
          error={errors.day}
          onChange={(event) => setOn(event.target.value)}
        />
        <TextField
          label={t('adSpend.campaign')}
          hint={t('adSpend.campaignHint')}
          autoComplete="off"
          ltr
          maxLength={200}
          value={campaign}
          error={errors.campaign}
          onChange={(event) => setCampaign(event.target.value)}
        />
        <TextField
          label={t('adSpend.amount')}
          hint={t('adSpend.amountHint')}
          inputMode="decimal"
          autoComplete="off"
          ltr
          required
          value={amount}
          error={errors.amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <Problems problems={problems} />
        {saved && <Alert tone="success">{saved}</Alert>}
        <Button
          type="submit"
          className="self-start"
          busy={set.isPending}
          disabled={!amount.trim()}
          icon={<Save aria-hidden className="size-5" />}
        >
          {t('adSpend.save')}
        </Button>
      </form>
    </FormSection>
  );
}

/** A day's spend in the list, and its removal: an amount of 0 for its platform, day and campaign. */
function SpendRow({ entry }: { entry: AdSpendEntryValue }) {
  const { t } = useLocale();
  const day = useDay();
  const set = useAdminMutation<AdSpendSetData, { entries: AdSpendInput[] }>(AdSpendSetMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const platform = t(`adSpend.platform.${entry.platform}` as MessageKey);
  const campaign = entry.campaign ?? t('adSpend.allCampaigns');
  const pulledFrom = PULLED_FROM[entry.source];

  const onRemove = async () => {
    setProblem(null);
    try {
      const { adSpendSet } = await set.mutateAsync({
        entries: [
          { platform: entry.platform, day: entry.day, campaign: entry.campaign, amount: '0' },
        ],
      });
      const error = adSpendSet.userErrors[0];
      if (error) setProblem(userErrorText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">
            {platform}
            <span className="text-secondary font-normal"> · {day(entry.day)}</span>
          </span>
          <span className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--hatti-type-body-sm-size)]">
            <span
              className={`break-all ${entry.campaign ? '' : 'text-secondary'}`}
              dir={entry.campaign ? 'ltr' : undefined}
            >
              {campaign}
            </span>
            {pulledFrom && (
              <span className="inline-flex items-center gap-1 text-secondary">
                <CloudDownload aria-hidden className="size-4" />
                {t(pulledFrom)}
              </span>
            )}
          </span>
        </span>
        <span className="num font-medium">
          {formatMoney(entry.amount.amount, entry.amount.currencyCode)}
        </span>
        <Button
          variant="danger"
          busy={set.isPending}
          aria-label={t('adSpend.remove', { platform, day: day(entry.day), campaign })}
          icon={<Trash2 aria-hidden className="size-5" />}
          onClick={() => void onRemove()}
        />
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/** The last 30 days' spend, the latest first, and what it came to. */
function RecentSpend() {
  const { t } = useLocale();
  const timezone = useShopTimezone();
  const from = dayIn(timezone, DAYS - 1);
  const to = dayIn(timezone);
  const query = useAdminQuery<AdSpendEntriesData>(['adSpendEntries'], AdSpendEntriesQuery, {
    from,
    to,
  });

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const entries = query.data.adSpendEntries;
  // In paisa, so that rupees and paisa add up exactly.
  const paisa = entries.reduce(
    (sum, entry) => sum + Math.round(Number(entry.amount.amount) * 100),
    0,
  );
  const currency = entries[0]?.amount.currencyCode ?? 'PKR';
  return (
    <>
      <h2 className="font-semibold">{t('adSpend.recent')}</h2>
      {entries.length === 0 ? (
        <EmptyState title={t('adSpend.none')} />
      ) : (
        <Card>
          <ul className="divide-y divide-line" aria-label={t('adSpend.recent')}>
            {entries.map((entry) => (
              <SpendRow
                key={`${entry.day}-${entry.platform}-${entry.campaign ?? ''}`}
                entry={entry}
              />
            ))}
          </ul>
          <p className="flex items-baseline justify-between gap-3 border-t border-line px-4 py-3">
            <span className="font-medium">{t('adSpend.total')}</span>
            <span className="num text-[length:var(--hatti-type-title-size)] font-semibold">
              {formatMoney((paisa / 100).toFixed(2), currency)}
            </span>
          </p>
        </Card>
      )}
    </>
  );
}

/**
 * Ad spend (ADR-553, ADR-554, ADR-565, ADR-567, ADR-679): what the shop spent on its ads, day by
 * day, by platform and, where it says, by campaign as its links' utm_campaign names it, pulled
 * from its Meta ad account, its TikTok advertiser account and its Google Ads account, recorded by
 * hand and taken away; and the last 30 days of it, with what they came to and which were pulled
 * from where. The sales report takes it off profit.
 */
export function AdSpendPage() {
  const { t } = useLocale();
  const shop = useShop();
  const allowed = permits(shop, SETS_META);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {allowed && <BackToMarketing />}
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <Banknote aria-hidden className="size-7 text-secondary" />
        {t('adSpend.title')}
      </h1>
      {allowed ? (
        <>
          <p className="text-secondary">{t('adSpend.intro')}</p>
          <MetaAdAccountSection />
          <TikTokAdAccountSection />
          <GoogleAdsAccountSection />
          <RecordSpend />
          <RecentSpend />
        </>
      ) : (
        <EmptyState title={t('adSpend.cannot')} />
      )}
    </div>
  );
}
