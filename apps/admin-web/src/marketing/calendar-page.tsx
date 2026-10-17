import { Link } from '@tanstack/react-router';
import { CalendarDays, Moon, Tag } from 'lucide-react';
import { useState } from 'react';
import { DiscountCodeCreateMutation, MarketingCalendarQuery } from '../api/operations';
import type {
  DiscountCodePayloadData,
  MarketingCalendarData,
  MarketingDateValue,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { endOfDayIn, formatDate, startOfDayIn } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';

/** A day, YYYY-MM-DD, as the admin writes dates. */
function useDay() {
  const { locale } = useLocale();
  return (day: string) => formatDate(`${day}T12:00:00Z`, 'UTC', locale);
}

/** A moment's card: its dates, what sells, and its kit, whose code a tap makes. */
function MomentCard({ date }: { date: MarketingDateValue }) {
  const { t } = useLocale();
  const day = useDay();
  const timezone = useShopTimezone();
  const shopId = useShop().id;
  const create = useAdminMutation<
    { discountCodeCreate: DiscountCodePayloadData },
    { discountCode: Record<string, unknown> }
  >(DiscountCodeCreateMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState(false);
  const { kit } = date;
  const name = t(`calendar.moment.${date.moment}`);

  const onMake = async () => {
    setProblem(null);
    try {
      const { discountCodeCreate } = await create.mutateAsync({
        discountCode: {
          code: kit.code,
          title: `${name} ${date.startsOn.slice(0, 4)}`,
          percentage: kit.percentage,
          startsAt: startOfDayIn(date.promoteFrom, timezone),
          endsAt: endOfDayIn(date.endsOn, timezone),
        },
      });
      const error = discountCodeCreate.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else setMade(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{name}</h2>
        {date.expected && (
          <Badge colour="needsConfirmation" icon={Moon} label={t('calendar.expected')} />
        )}
      </div>
      <p>
        {date.startsOn === date.endsOn
          ? day(date.startsOn)
          : t('calendar.dates', { from: day(date.startsOn), to: day(date.endsOn) })}
        <span className="text-secondary">
          {' · '}
          {t('calendar.promoteFrom', { date: day(date.promoteFrom) })}
        </span>
      </p>
      <p className="text-secondary">{t(`calendar.idea.${date.moment}`)}</p>
      <div className="flex flex-col gap-2 rounded-control border border-line p-3">
        <p className="font-medium">
          {t('calendar.kit', { percentage: kit.percentage, code: kit.code })}
        </p>
        <p className="text-[length:var(--hatti-type-body-sm-size)]">
          <span className="text-secondary">{t('calendar.english')} </span>
          <span dir="ltr">{kit.messageEnglish}</span>
        </p>
        <p className="text-[length:var(--hatti-type-body-sm-size)]">
          <span className="text-secondary">{t('calendar.urdu')} </span>
          <span dir="rtl" lang="ur">
            {kit.messageUrdu}
          </span>
        </p>
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {made ? (
        <Alert tone="success">
          {t('calendar.made', {
            code: kit.code,
            from: day(date.promoteFrom),
            to: day(date.endsOn),
          })}{' '}
          <Link
            to="/$shopId/marketing"
            params={{ shopId }}
            className="font-medium text-primary hover:underline"
          >
            {t('calendar.writeBroadcast')}
          </Link>
        </Alert>
      ) : (
        <Button
          variant="secondary"
          className="self-start"
          busy={create.isPending}
          icon={<Tag aria-hidden className="size-5" />}
          onClick={() => void onMake()}
        >
          {t('calendar.makeCode', { code: kit.code })}
        </Button>
      )}
    </Card>
  );
}

/**
 * Pakistan's marketing calendar (MKT-16, ADR-484): the moments the shop's customers buy for in
 * the year ahead, soonest first, each with when to start, what sells, and a ready-made campaign
 * whose discount code a tap makes for its days.
 */
export function CalendarPage() {
  const { t } = useLocale();
  const query = useAdminQuery<MarketingCalendarData>(['marketingCalendar'], MarketingCalendarQuery);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <CalendarDays aria-hidden className="size-7 text-secondary" />
        {t('calendar.title')}
      </h1>
      <p className="text-secondary">{t('calendar.intro')}</p>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.marketingCalendar.length === 0 ? (
        <EmptyState title={t('calendar.none')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.marketingCalendar.map((date) => (
            <li key={`${date.moment}-${date.startsOn}`}>
              <MomentCard date={date} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
