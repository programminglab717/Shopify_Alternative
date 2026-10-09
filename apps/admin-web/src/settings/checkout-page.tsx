import { ArrowDown, ArrowUp, BadgeCheck, Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CheckoutMarketingChannelsUpdateMutation,
  CheckoutPageQuery,
  CheckoutTrustBadgesUpdateMutation,
} from '../api/operations';
import type {
  CheckoutMarketingChannelsUpdateData,
  CheckoutPageData,
  CheckoutTrustBadgeKind,
  CheckoutTrustBadgesUpdateData,
  MarketingChannel,
} from '../api/types';
import { CHANNELS } from '../customers/care';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField, parseWhole, Problems, SelectField } from './settings-form';
import { BackToSettings } from './settings-page';

const KINDS: readonly CheckoutTrustBadgeKind[] = [
  'CASH_ON_DELIVERY',
  'OPEN_PARCEL',
  'ORIGINAL',
  'EXCHANGE',
  'RETURNS',
  'WHATSAPP',
];

/** Badges that say within how many days. */
const WITH_DAYS: ReadonlySet<CheckoutTrustBadgeKind> = new Set(['EXCHANGE', 'RETURNS']);

/** The most badges the checkout shows. */
const MOST = 4;

interface BadgeRow {
  key: number;
  kind: CheckoutTrustBadgeKind;
  days: string;
}

/** The badges as the core takes them, from what the form holds. */
function badgesOf(rows: readonly BadgeRow[]) {
  return rows.map((row) =>
    WITH_DAYS.has(row.kind) ? { kind: row.kind, days: parseWhole(row.days) } : { kind: row.kind },
  );
}

function CheckoutForm({ data }: { data: CheckoutPageData }) {
  const { t } = useLocale();
  const next = useRef(0);
  const keyed = () =>
    data.checkoutTrustBadges.map((badge) => ({
      key: (next.current += 1),
      kind: badge.kind,
      days: badge.days === null ? '' : String(badge.days),
    }));
  const updateBadges = useAdminMutation<
    CheckoutTrustBadgesUpdateData,
    { badges: Record<string, unknown>[] }
  >(CheckoutTrustBadgesUpdateMutation);
  const updateChannels = useAdminMutation<
    CheckoutMarketingChannelsUpdateData,
    { channels: MarketingChannel[] }
  >(CheckoutMarketingChannelsUpdateMutation);
  const [rows, setRows] = useState<BadgeRow[]>(keyed);
  const [channels, setChannels] = useState<MarketingChannel[]>(data.checkoutMarketingChannels);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const hasWhatsapp = Boolean(data.onlineStorePreferences.whatsappNumber);

  const unused = KINDS.filter((kind) => !rows.some((row) => row.kind === kind));
  const [adding, setAdding] = useState<CheckoutTrustBadgeKind | ''>('');
  const badgesNow = badgesOf(rows);
  const badgesWas = data.checkoutTrustBadges.map((badge) =>
    WITH_DAYS.has(badge.kind) ? { kind: badge.kind, days: badge.days } : { kind: badge.kind },
  );
  const badgesChanged = JSON.stringify(badgesNow) !== JSON.stringify(badgesWas);
  const channelsNow = CHANNELS.filter((channel) => channels.includes(channel));
  const channelsChanged =
    JSON.stringify(channelsNow) !==
    JSON.stringify(CHANNELS.filter((channel) => data.checkoutMarketingChannels.includes(channel)));
  const changed = badgesChanged || channelsChanged;

  const move = (index: number, by: -1 | 1) =>
    setRows((all) => {
      const copy = [...all];
      const [row] = copy.splice(index, 1);
      copy.splice(index + by, 0, row!);
      return copy;
    });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    const bad = rows.find((row) => {
      if (!WITH_DAYS.has(row.kind)) return false;
      const days = parseWhole(row.days);
      return days === null || Number.isNaN(days) || days < 1 || days > 90;
    });
    if (bad) {
      setProblems([
        `${t(`checkoutPage.badge.${bad.kind}` as MessageKey, { days: bad.days.trim() || '…' })}: ${t('checkoutPage.badDays')}`,
      ]);
      return;
    }
    setProblems([]);
    setSaved(false);
    try {
      if (badgesChanged) {
        const { checkoutTrustBadgesUpdate } = await updateBadges.mutateAsync({ badges: badgesNow });
        if (checkoutTrustBadgesUpdate.userErrors.length > 0) {
          setProblems(checkoutTrustBadgesUpdate.userErrors.map((error) => problemText(error, t)));
          return;
        }
      }
      if (channelsChanged) {
        const { checkoutMarketingChannelsUpdate } = await updateChannels.mutateAsync({
          channels: channelsNow,
        });
        if (checkoutMarketingChannelsUpdate.userErrors.length > 0) {
          setProblems(
            checkoutMarketingChannelsUpdate.userErrors.map((error) => problemText(error, t)),
          );
          return;
        }
      }
      setSaved(true);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <FormSection title={t('checkoutPage.badges')} hint={t('checkoutPage.badgesHint')}>
        {rows.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {rows.map((row, index) => {
              const label = t(`checkoutPage.badge.${row.kind}` as MessageKey, {
                days: row.days.trim() || '…',
              });
              return (
                <li
                  key={row.key}
                  className="flex flex-wrap items-end gap-3 rounded-control border border-line p-3"
                >
                  <span className="flex min-w-40 flex-1 flex-col">
                    <span className="font-medium">{label}</span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {t(`checkoutPage.badgeHint.${row.kind}` as MessageKey)}
                    </span>
                  </span>
                  {WITH_DAYS.has(row.kind) && (
                    <TextField
                      label={t('checkoutPage.daysOf', { badge: label })}
                      inputMode="numeric"
                      ltr
                      className="w-28"
                      value={row.days}
                      onChange={(event) =>
                        setRows((all) =>
                          all.map((each) =>
                            each.key === row.key ? { ...each, days: event.target.value } : each,
                          ),
                        )
                      }
                    />
                  )}
                  <span className="flex gap-1">
                    <Button
                      variant="tertiary"
                      aria-label={t('checkoutPage.up', { badge: label })}
                      disabled={index === 0}
                      icon={<ArrowUp aria-hidden className="size-5" />}
                      onClick={() => move(index, -1)}
                    />
                    <Button
                      variant="tertiary"
                      aria-label={t('checkoutPage.down', { badge: label })}
                      disabled={index === rows.length - 1}
                      icon={<ArrowDown aria-hidden className="size-5" />}
                      onClick={() => move(index, 1)}
                    />
                    <Button
                      variant="danger"
                      aria-label={t('checkoutPage.remove', { badge: label })}
                      icon={<Trash2 aria-hidden className="size-5" />}
                      onClick={() => setRows((all) => all.filter((each) => each.key !== row.key))}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-secondary">{t('checkoutPage.noBadges')}</p>
        )}
        {rows.length < MOST && unused.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <SelectField<CheckoutTrustBadgeKind | ''>
                label={t('checkoutPage.addBadge')}
                value={adding}
                options={[
                  { value: '', label: t('checkoutPage.choose') },
                  ...unused
                    .filter((kind) => kind !== 'WHATSAPP' || hasWhatsapp)
                    .map((kind) => ({
                      value: kind,
                      label: t(`checkoutPage.badge.${kind}` as MessageKey, { days: '7' }),
                    })),
                ]}
                onChange={setAdding}
              />
            </div>
            <Button
              variant="secondary"
              disabled={!adding}
              icon={<Plus aria-hidden className="size-5" />}
              onClick={() => {
                if (!adding) return;
                setRows((all) => [
                  ...all,
                  {
                    key: (next.current += 1),
                    kind: adding,
                    days: WITH_DAYS.has(adding) ? '7' : '',
                  },
                ]);
                setAdding('');
              }}
            >
              {t('checkoutPage.add')}
            </Button>
          </div>
        )}
        {!hasWhatsapp && unused.includes('WHATSAPP') && (
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('checkoutPage.whatsappNeeded')}
          </p>
        )}
      </FormSection>

      <FormSection title={t('checkoutPage.boxes')} hint={t('checkoutPage.boxesHint')}>
        {CHANNELS.map((channel) => (
          <CheckField
            key={channel}
            label={t(`checkoutPage.box.${channel}` as MessageKey)}
            checked={channels.includes(channel)}
            onChange={(on) =>
              setChannels((all) =>
                on ? [...all, channel] : all.filter((each) => each !== channel),
              )
            }
          />
        ))}
      </FormSection>

      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('checkoutPage.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={updateBadges.isPending || updateChannels.isPending}
        disabled={!changed}
        icon={<Save aria-hidden className="size-5" />}
      >
        {t('checkoutPage.save')}
      </Button>
    </form>
  );
}

/**
 * The checkout's page (CHK-14, CUS-04, ADR-187): the badges under its button that reassure a
 * shopper paying on delivery, up to four in the shop's order, with the days for exchanges and
 * returns; and the boxes it offers for the shop's news and offers, each unticked until ticked.
 */
export function CheckoutPage() {
  const { t } = useLocale();
  const query = useAdminQuery<CheckoutPageData>(['checkoutPage'], CheckoutPageQuery);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <BadgeCheck aria-hidden className="size-7 text-secondary" />
        {t('checkoutPage.title')}
      </h1>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : (
        <CheckoutForm data={query.data} />
      )}
    </div>
  );
}
