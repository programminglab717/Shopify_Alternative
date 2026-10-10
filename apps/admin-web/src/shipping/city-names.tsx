/** Couriers' names for the cities parcels go to (SHP-03, ADR-233), chosen in the admin. */
import { Link } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  CourierCityMatchQuery,
  CourierCityNameSetMutation,
  OrderCityQuery,
  OrdersBookMutation,
} from '../api/operations';
import type {
  CourierBooking,
  CourierCityMatchData,
  CourierCityMatchValue,
  CourierCityNameSetData,
  OrderCityData,
  OrdersBookData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The radio for a name typed out rather than one of the courier's nearest. */
const ANOTHER = '';

/**
 * A city's name with a courier account's courier, chosen: one of the courier's nearest names, or
 * another typed out as its list writes it, which the core checks against the list. The shop keeps
 * it as its own name for the city with that courier, for the next parcel there.
 */
function CityNamer({
  accountId,
  courierName,
  match,
  saveLabel,
  onSaved,
}: {
  accountId: string;
  courierName: string;
  match: CourierCityMatchValue;
  saveLabel: string;
  onSaved: (match: CourierCityMatchValue) => Promise<void> | void;
}) {
  const { t } = useLocale();
  const set = useAdminMutation<
    CourierCityNameSetData,
    { input: { accountId: string; city: string; courierCity: string } }
  >(CourierCityNameSetMutation);
  const [choice, setChoice] = useState(match.suggestions[0] ?? ANOTHER);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const radios = useId();
  const name = choice === ANOTHER ? typed.trim() : choice;
  const values = { courier: courierName, city: match.city };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSaving(true);
    try {
      const { courierCityNameSet: payload } = await set.mutateAsync({
        input: { accountId, city: match.city, courierCity: name },
      });
      const error = payload.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else if (payload.match) await onSaved(payload.match);
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      {match.suggestions.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium">{t('cities.choose', values)}</legend>
          {match.suggestions.map((each) => (
            <label key={each} className="flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name={radios}
                checked={choice === each}
                onChange={() => setChoice(each)}
                className="size-5 accent-[var(--hatti-color-primary)]"
              />
              <span dir="auto">{each}</span>
            </label>
          ))}
          <label className="flex min-h-10 items-center gap-2">
            <input
              type="radio"
              name={radios}
              checked={choice === ANOTHER}
              onChange={() => setChoice(ANOTHER)}
              className="size-5 accent-[var(--hatti-color-primary)]"
            />
            {t('cities.another')}
          </label>
        </fieldset>
      )}
      {choice === ANOTHER && (
        <TextField
          label={t('cities.courierName', values)}
          hint={t('cities.courierNameHint', values)}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          dir="auto"
          required
        />
      )}
      {problem && (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      )}
      <Button type="submit" busy={saving} disabled={!name} className="self-start">
        {saveLabel}
      </Button>
    </form>
  );
}

/**
 * How a city matches a courier account's courier's names, as a parcel there would be booked: the
 * courier's name for it and where that came from, with another given if staff know better; or,
 * where the courier has none, its nearest names to choose from. `action` is what staff may do
 * with a city the courier knows.
 */
export function CityMatch({
  accountId,
  courierName,
  city,
  saveLabel,
  onSaved,
  action,
}: {
  accountId: string;
  courierName: string;
  city: string;
  saveLabel: string;
  onSaved: (match: CourierCityMatchValue) => Promise<void> | void;
  action?: ReactNode;
}) {
  const { t } = useLocale();
  const query = useAdminQuery<CourierCityMatchData>(['courierCityMatch'], CourierCityMatchQuery, {
    accountId,
    city,
  });
  const [renaming, setRenaming] = useState(false);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const match = query.data.courierCityMatch;
  const values = { courier: courierName, city: match.city };
  const namer = (suggested: CourierCityMatchValue) => (
    <CityNamer
      accountId={accountId}
      courierName={courierName}
      match={suggested}
      saveLabel={saveLabel}
      onSaved={onSaved}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {match.listError && (
        <Alert tone="warning">{t('cities.listError', { ...values, error: match.listError })}</Alert>
      )}
      {match.courierCity === null ? (
        <>
          <p className="font-medium">{t('cities.unknown', values)}</p>
          {namer(match)}
        </>
      ) : (
        <>
          <p>
            <span className="font-medium">
              {t('cities.known', { ...values, courierCity: match.courierCity })}
            </span>
            {match.source && (
              <span className="text-secondary">
                {' '}
                {t(`cities.source.${match.source}` as MessageKey, values)}
              </span>
            )}
          </p>
          {renaming ? (
            namer({ ...match, suggestions: [] })
          ) : (
            <div className="flex flex-wrap gap-2">
              {action}
              <Button variant="tertiary" onClick={() => setRenaming(true)}>
                {t('cities.rename')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A failed booking put right and booked again with the same courier account: the city its order's
 * address writes matched against the courier's names; where the courier has none, one chosen and
 * kept as the shop's own, then the order booked again; where it has, the order booked again as it
 * is, or with another name. An order whose address names no city is corrected on its page first.
 */
export function CityFix({
  booking,
  onDone,
}: {
  booking: CourierBooking;
  onDone: (said: string) => void;
}) {
  const { t } = useLocale();
  const shopId = useShop().id;
  const order = useAdminQuery<OrderCityData>(['orderCity'], OrderCityQuery, {
    id: booking.orderId,
  });
  const book = useAdminMutation<OrdersBookData, { ids: string[]; accountId: string }>(
    OrdersBookMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);

  const bookAgain = async () => {
    setProblem(null);
    try {
      const { ordersBook } = await book.mutateAsync({
        ids: [booking.orderId],
        accountId: booking.accountId,
      });
      const refusal = ordersBook.refused[0]?.message ?? ordersBook.userErrors[0]?.message;
      if (refusal) setProblem(`${booking.orderName} ${refusal}`);
      else onDone(t('cities.booked', { name: booking.orderName, courier: booking.courierName }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  let body;
  if (order.isPending) body = <Loading label={t('state.loading')} />;
  else if (order.isError) body = <ErrorState message={errorText(order.error, t)} />;
  else {
    const city = order.data.order?.shippingAddress?.city.trim() ?? '';
    body =
      city === '' ? (
        <p>
          {t('cities.noCity')}{' '}
          <Link
            to="/$shopId/orders/$orderId"
            params={{ shopId, orderId: booking.orderId }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('cities.openOrder', { name: booking.orderName })}
          </Link>
        </p>
      ) : (
        <CityMatch
          accountId={booking.accountId}
          courierName={booking.courierName}
          city={city}
          saveLabel={t('cities.keepAndBook')}
          onSaved={bookAgain}
          action={
            <Button
              icon={<RotateCcw aria-hidden className="size-5" />}
              busy={book.isPending}
              onClick={() => void bookAgain()}
            >
              {t('cities.bookAgain')}
            </Button>
          }
        />
      );
  }

  return (
    <div className="flex flex-col gap-3 rounded-control border border-line bg-canvas p-3">
      {body}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}
