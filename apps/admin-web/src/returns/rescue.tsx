import type { OrderStage as BadgeColour } from '@hatti/tokens';
import { CircleHelp, PhoneCall, RotateCcw, Truck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DeliveriesToRescueQuery } from '../api/operations';
import type { DeliveriesToRescueData, DeliveryRescueAnswer } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatRelative } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { ParcelTitle } from './parcel';

/** How a customer's answer shows: deliver again green, call first amber, none yet grey. */
const ANSWER_BADGES: Record<
  DeliveryRescueAnswer | 'NONE',
  { colour: BadgeColour; icon: LucideIcon }
> = {
  RETRY: { colour: 'delivered', icon: RotateCcw },
  CALL: { colour: 'needsConfirmation', icon: PhoneCall },
  NONE: { colour: 'cancelled', icon: CircleHelp },
};

/**
 * Deliveries that failed (COD-08, ADR-388): parcels whose courier tried and couldn't, those whose
 * customers answered on WhatsApp first, with their answer: deliver again, or call them first, for
 * the shop to tell the courier before it sends the parcel back.
 */
export function Rescue() {
  const { t, locale } = useLocale();
  const timeZone = useShopTimezone();
  const query = useAdminQuery<DeliveriesToRescueData>(
    ['deliveriesToRescue'],
    DeliveriesToRescueQuery,
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) return <ErrorState message={errorText(query.error, t)} />;
  const { count, parcels } = query.data.deliveriesToRescue;

  return (
    <>
      <p className="text-secondary">{t('returns.rescue.hint')}</p>
      {parcels.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Truck aria-hidden className="size-8 text-success" />}
            title={t('returns.rescue.none')}
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {parcels.map((parcel) => {
              const answer = parcel.answer ?? 'NONE';
              const badge = ANSWER_BADGES[answer];
              const who = [parcel.customerName, parcel.city].filter(Boolean).join(' · ');
              return (
                <li key={parcel.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <ParcelTitle
                      orderId={parcel.orderId}
                      orderName={parcel.orderName}
                      tracking={parcel.trackingInfo}
                    />
                    <Badge
                      colour={badge.colour}
                      icon={badge.icon}
                      label={t(`returns.rescue.answer.${answer}` as MessageKey)}
                    />
                  </div>
                  {who && <span>{who}</span>}
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('returns.rescue.tried', {
                      count: formatCount(parcel.attempts),
                      when: formatRelative(parcel.attemptedAt, timeZone, locale),
                    })}
                    {parcel.reason && (
                      <>
                        {' · '}
                        {/* The courier's own words, in their own direction. */}
                        <bdi>“{parcel.reason}”</bdi>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {count > parcels.length && (
        <p className="text-secondary">
          {t('returns.rescue.more', {
            shown: formatCount(parcels.length),
            count: formatCount(count),
          })}
        </p>
      )}
    </>
  );
}
