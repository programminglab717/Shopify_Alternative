import { ArrowDown, ArrowUp, BadgeCheck, Gift, Plus, Save, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CheckoutGiftOptionsUpdateMutation,
  CheckoutMarketingChannelsUpdateMutation,
  CheckoutPageQuery,
  CheckoutRecoverySettingsUpdateMutation,
  CheckoutStockHoldUpdateMutation,
  CheckoutTrustBadgesUpdateMutation,
} from '../api/operations';
import type {
  CheckoutGiftOptionsUpdateData,
  CheckoutMarketingChannelsUpdateData,
  CheckoutPageData,
  CheckoutRecoverySettingsUpdateData,
  CheckoutStockHoldUpdateData,
  CheckoutTrustBadgeKind,
  CheckoutTrustBadgesUpdateData,
  MarketingChannel,
  MoneyValue,
} from '../api/types';
import { CHANNELS } from '../customers/care';
import { ProductPicker } from '../drafts/new-draft-page';
import { errorText } from '../i18n/errors';
import { formatMoney } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { partTitle } from '../products/bundle';
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
  'CUSTOM',
];

/** Badges that say within how many days. */
const WITH_DAYS: ReadonlySet<CheckoutTrustBadgeKind> = new Set(['EXCHANGE', 'RETURNS']);

/** The most badges the checkout shows. */
const MOST = 4;

/** The most a badge in the shop's own words says (ADR-711). */
const MOST_TEXT = 60;

/** How long after a shopper leaves the shop may remind them, in minutes (ADR-393); '' for never. */
export const REMINDER_DELAYS = ['', '30', '60', '180', '600'] as const;
type ReminderDelay = (typeof REMINDER_DELAYS)[number];

/** How long a checkout may hold its cart's stock, in minutes (ADR-715); '' for not at all. */
const HOLD_MINUTES = ['', '5', '10', '15', '30', '60'] as const;

/** How many hours after the reminder the shop may offer one of its codes (ADR-426). */
const OFFER_DELAYS = ['12', '24', '48'] as const;
type OfferDelay = (typeof OFFER_DELAYS)[number];

interface BadgeRow {
  key: number;
  kind: CheckoutTrustBadgeKind;
  days: string;
  text: string;
}

/** A badge's own words on one line, as the core keeps them. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The badges as the core takes them, from what the form holds. */
function badgesOf(rows: readonly BadgeRow[]) {
  return rows.map((row) =>
    WITH_DAYS.has(row.kind)
      ? { kind: row.kind, days: parseWhole(row.days) }
      : row.kind === 'CUSTOM'
        ? { kind: row.kind, text: oneLine(row.text) }
        : { kind: row.kind },
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
      text: badge.text ?? '',
    }));
  const updateBadges = useAdminMutation<
    CheckoutTrustBadgesUpdateData,
    { badges: Record<string, unknown>[] }
  >(CheckoutTrustBadgesUpdateMutation);
  const updateChannels = useAdminMutation<
    CheckoutMarketingChannelsUpdateData,
    { channels: MarketingChannel[] }
  >(CheckoutMarketingChannelsUpdateMutation);
  const updateRecovery = useAdminMutation<
    CheckoutRecoverySettingsUpdateData,
    {
      reminderAfterMinutes: number | null;
      offerDiscountCodeId: string | null;
      offerAfterHours: number | null;
    }
  >(CheckoutRecoverySettingsUpdateMutation);
  const recovery = data.checkoutRecoverySettings;
  const delayWas = String(recovery.reminderAfterMinutes ?? '') as ReminderDelay;
  const [delay, setDelay] = useState<ReminderDelay>(delayWas);
  // The code offered after the reminder, and how long after (ADR-426): '' for none.
  const offerWas = recovery.offerDiscountCode?.id ?? '';
  const hoursWas = String(recovery.offerAfterHours ?? 24) as OfferDelay;
  const [offer, setOffer] = useState(offerWas);
  const [hours, setHours] = useState<OfferDelay>(hoursWas);
  // Codes that take something off the items; the one offered even if past the first hundred.
  const offerable = (data.discountCodes?.nodes ?? []).filter(
    (code) => code.kind !== 'FREE_SHIPPING',
  );
  if (recovery.offerDiscountCode && !offerable.some((code) => code.id === offerWas)) {
    offerable.unshift({
      id: recovery.offerDiscountCode.id,
      code: recovery.offerDiscountCode.code,
      kind: 'PERCENTAGE',
      summary: recovery.offerDiscountCode.summary ?? '',
      status: 'ACTIVE',
    });
  }
  const [rows, setRows] = useState<BadgeRow[]>(keyed);
  const [channels, setChannels] = useState<MarketingChannel[]>(data.checkoutMarketingChannels);
  const updateGift = useAdminMutation<
    CheckoutGiftOptionsUpdateData,
    { input: { wrapVariantId: string | null; messages: boolean } }
  >(CheckoutGiftOptionsUpdateMutation);
  // Gift wrap and gift messages (CHK-16, ADR-413).
  const giftWas = data.checkoutGiftOptions ?? { wrap: null, messages: false };
  const [wrap, setWrap] = useState<{ variantId: string; title: string; price: MoneyValue } | null>(
    giftWas.wrap && {
      variantId: giftWas.wrap.variantId,
      title: partTitle(giftWas.wrap),
      price: giftWas.wrap.price,
    },
  );
  const [messages, setMessages] = useState(giftWas.messages);
  const [picking, setPicking] = useState(false);
  const giftChanged =
    (wrap?.variantId ?? null) !== (giftWas.wrap?.variantId ?? null) ||
    messages !== giftWas.messages;
  const updateHold = useAdminMutation<CheckoutStockHoldUpdateData, { minutes: number | null }>(
    CheckoutStockHoldUpdateMutation,
  );
  // Stock held while a shopper checks out (ADR-715): minutes set through the API offered too.
  const holdWas = String(data.checkoutStockHold?.minutes ?? '');
  const [hold, setHold] = useState(holdWas);
  const holdOptions: string[] = [...HOLD_MINUTES];
  if (!holdOptions.includes(holdWas)) holdOptions.push(holdWas);
  holdOptions.sort((a, b) => Number(a) - Number(b));
  const holdChanged = hold !== holdWas;
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const hasWhatsapp = Boolean(data.onlineStorePreferences.whatsappNumber);

  // A badge in the shop's own words may come more than once.
  const unused = KINDS.filter(
    (kind) => kind === 'CUSTOM' || !rows.some((row) => row.kind === kind),
  );
  const [adding, setAdding] = useState<CheckoutTrustBadgeKind | ''>('');
  const badgesNow = badgesOf(rows);
  const badgesWas = badgesOf(
    data.checkoutTrustBadges.map((badge) => ({
      key: 0,
      kind: badge.kind,
      days: badge.days === null ? '' : String(badge.days),
      text: badge.text ?? '',
    })),
  );
  const badgesChanged = JSON.stringify(badgesNow) !== JSON.stringify(badgesWas);
  const channelsNow = CHANNELS.filter((channel) => channels.includes(channel));
  const channelsChanged =
    JSON.stringify(channelsNow) !==
    JSON.stringify(CHANNELS.filter((channel) => data.checkoutMarketingChannels.includes(channel)));
  const offerNow = delay === '' ? '' : offer;
  const delayChanged =
    delay !== delayWas || offerNow !== offerWas || (offerNow !== '' && hours !== hoursWas);
  const changed = badgesChanged || channelsChanged || delayChanged || giftChanged || holdChanged;

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
    const wordless = rows.find((row) => row.kind === 'CUSTOM' && oneLine(row.text) === '');
    if (wordless) {
      setProblems([t('checkoutPage.badText')]);
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
      if (delayChanged) {
        const { checkoutRecoverySettingsUpdate } = await updateRecovery.mutateAsync({
          reminderAfterMinutes: delay === '' ? null : Number(delay),
          offerDiscountCodeId: offerNow || null,
          offerAfterHours: offerNow ? Number(hours) : null,
        });
        if (checkoutRecoverySettingsUpdate.userErrors.length > 0) {
          setProblems(
            checkoutRecoverySettingsUpdate.userErrors.map((error) => problemText(error, t)),
          );
          return;
        }
      }
      if (giftChanged) {
        const { checkoutGiftOptionsUpdate } = await updateGift.mutateAsync({
          input: { wrapVariantId: wrap?.variantId ?? null, messages },
        });
        if (checkoutGiftOptionsUpdate.userErrors.length > 0) {
          setProblems(checkoutGiftOptionsUpdate.userErrors.map((error) => problemText(error, t)));
          return;
        }
      }
      if (holdChanged) {
        const { checkoutStockHoldUpdate } = await updateHold.mutateAsync({
          minutes: hold === '' ? null : Number(hold),
        });
        if (checkoutStockHoldUpdate.userErrors.length > 0) {
          setProblems(checkoutStockHoldUpdate.userErrors.map((error) => problemText(error, t)));
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
              const label =
                row.kind === 'CUSTOM'
                  ? oneLine(row.text) || t('checkoutPage.badge.CUSTOM')
                  : t(`checkoutPage.badge.${row.kind}` as MessageKey, {
                      days: row.days.trim() || '…',
                    });
              return (
                <li
                  key={row.key}
                  className="flex flex-wrap items-end gap-3 rounded-control border border-line p-3"
                >
                  <span className="flex min-w-40 flex-1 flex-col">
                    <span className="font-medium" dir="auto">
                      {label}
                    </span>
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
                  {row.kind === 'CUSTOM' && (
                    <TextField
                      label={t('checkoutPage.badgeText')}
                      dir="auto"
                      maxLength={MOST_TEXT}
                      className="min-w-56 flex-1"
                      placeholder={t('checkoutPage.badgeTextExample')}
                      value={row.text}
                      onChange={(event) =>
                        setRows((all) =>
                          all.map((each) =>
                            each.key === row.key ? { ...each, text: event.target.value } : each,
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
                    text: '',
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

      <FormSection title={t('checkoutPage.reminder')} hint={t('checkoutPage.reminderHint')}>
        <SelectField<ReminderDelay>
          label={t('checkoutPage.reminderAfter')}
          value={delay}
          options={REMINDER_DELAYS.map((value) => ({
            value,
            label: t(
              value === ''
                ? 'checkoutPage.reminderNever'
                : (`checkoutPage.reminder.${value}` as MessageKey),
            ),
          }))}
          onChange={setDelay}
        />
        {delay !== '' && (
          <>
            <SelectField<string>
              label={t('checkoutPage.offer')}
              value={offer}
              options={[
                { value: '', label: t('checkoutPage.offerNone') },
                ...offerable.map((code) => ({
                  value: code.id,
                  label:
                    code.status === 'EXPIRED'
                      ? t('checkoutPage.offerExpired', { code: code.code, summary: code.summary })
                      : `${code.code} · ${code.summary}`,
                })),
              ]}
              onChange={setOffer}
            />
            {offer !== '' && (
              <SelectField<OfferDelay>
                label={t('checkoutPage.offerAfter')}
                value={hours}
                options={OFFER_DELAYS.map((value) => ({
                  value,
                  label: t(`checkoutPage.offerAfter.${value}` as MessageKey),
                }))}
                onChange={setHours}
              />
            )}
            <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {t(offerable.length === 0 ? 'checkoutPage.offerNoCodes' : 'checkoutPage.offerHint')}
            </p>
          </>
        )}
      </FormSection>

      <FormSection title={t('checkoutPage.gifts')} hint={t('checkoutPage.giftsHint')}>
        {wrap ? (
          <div className="flex items-center gap-3 rounded-control border border-line px-3 py-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span dir="auto">{wrap.title}</span>
              <span className="num text-secondary">{formatMoney(wrap.price.amount)}</span>
              {giftWas.wrap?.variantId === wrap.variantId && !giftWas.wrap.forSale && (
                <span className="text-warning">{t('checkoutPage.wrapOffSale')}</span>
              )}
            </span>
            <Button
              variant="tertiary"
              icon={<Trash2 aria-hidden className="size-5" />}
              aria-label={t('checkoutPage.removeWrap')}
              onClick={() => setWrap(null)}
            />
          </div>
        ) : (
          <p className="text-secondary">{t('checkoutPage.noGiftWrap')}</p>
        )}
        {picking ? (
          <ProductPicker
            onAdd={(picked) => {
              setWrap({ variantId: picked.variantId, title: picked.title, price: picked.price });
              setPicking(false);
            }}
          />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Gift aria-hidden className="size-5" />}
            onClick={() => setPicking(true)}
          >
            {t(wrap ? 'checkoutPage.changeWrap' : 'checkoutPage.chooseWrap')}
          </Button>
        )}
        <CheckField
          label={t('checkoutPage.giftMessages')}
          hint={t('checkoutPage.giftMessagesHint')}
          checked={messages}
          onChange={setMessages}
        />
      </FormSection>

      <FormSection title={t('checkoutPage.hold')} hint={t('checkoutPage.holdHint')}>
        <SelectField<string>
          label={t('checkoutPage.holdFor')}
          value={hold}
          options={holdOptions.map((value) => ({
            value,
            label:
              value === ''
                ? t('checkoutPage.holdNever')
                : t('checkoutPage.holdMinutes', { minutes: value }),
          }))}
          onChange={setHold}
        />
      </FormSection>

      <Problems problems={problems} />
      {saved && !changed && <Alert tone="success">{t('checkoutPage.saved')}</Alert>}
      <Button
        type="submit"
        className="self-start"
        busy={
          updateBadges.isPending ||
          updateChannels.isPending ||
          updateRecovery.isPending ||
          updateGift.isPending ||
          updateHold.isPending
        }
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
 * returns; the boxes it offers for the shop's news and offers, each unticked until ticked; how
 * long after a shopper leaves it they are reminded on WhatsApp, if at all (CHK-12, ADR-393); and
 * which of the shop's codes those who still do not order are offered after, if any (ADR-426);
 * and how long a checkout holds its cart's stock for its shopper, if at all (ADR-715).
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
