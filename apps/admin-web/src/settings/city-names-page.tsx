import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, MapPin, Search } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CourierCityNameSetMutation, CourierCityNamesQuery } from '../api/operations';
import type { CourierCityNameSetData, CourierCityNamesData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { CityMatch } from '../shipping/city-names';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/**
 * The shop's own names for cities with a courier account's courier (SHP-03, ADR-233): each city as
 * orders write it and the courier's name for it, the latest changed first, forgotten when wrong;
 * and a city looked up, how the courier knows it, and named for the next parcel there.
 */
export function CityNamesPage() {
  const { t, locale } = useLocale();
  const shopId = useShop().id;
  const timezone = useShopTimezone();
  const { accountId } = useParams({ from: '/$shopId/settings/couriers/$accountId/cities' });
  const query = useAdminQuery<CourierCityNamesData>(['courierCityNames'], CourierCityNamesQuery, {
    accountId,
  });
  const forget = useAdminMutation<
    CourierCityNameSetData,
    { input: { accountId: string; city: string; courierCity: null } }
  >(CourierCityNameSetMutation);
  const [words, setWords] = useState('');
  const [looked, setLooked] = useState('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const onForget = async (city: string) => {
    setSaid('');
    setProblem(null);
    try {
      const { courierCityNameSet: payload } = await forget.mutateAsync({
        input: { accountId, city, courierCity: null },
      });
      if (payload.userErrors[0]) setProblem(problemText(payload.userErrors[0], t));
      else setSaid(t('cities.forgotten', { city }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const onLookUp = (event: FormEvent) => {
    event.preventDefault();
    setSaid('');
    setProblem(null);
    setLooked(words.trim());
  };

  const back = (
    <Link
      to="/$shopId/settings/couriers"
      params={{ shopId }}
      className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
    >
      <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
      {t('settings.couriers')}
    </Link>
  );

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
        {back}
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      </div>
    );
  }
  const account = query.data.courierAccounts.find((each) => each.id === accountId);
  if (!account) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
        {back}
        <EmptyState title={t('cities.missing')} />
      </div>
    );
  }
  const courier = account.courierName;
  const names = [...query.data.courierCityNames].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      {back}
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold" dir="auto">
        {t('cities.titleOf', { account: account.name })}
      </h1>
      <p className="text-secondary">{t('cities.hint', { courier })}</p>
      {said && <Alert tone="success">{said}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Card>
        {names.length === 0 ? (
          <EmptyState
            icon={<MapPin aria-hidden className="size-8 text-secondary" />}
            title={t('cities.none')}
          />
        ) : (
          <ul className="divide-y divide-line">
            {names.map((name) => (
              <li key={name.city} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <span className="font-medium" dir="auto">
                  {name.city}
                </span>
                <ArrowRight aria-hidden className="size-4 text-secondary rtl:rotate-180" />
                <span dir="auto">{name.courierCity}</span>
                <span className="flex-1" />
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {formatDate(name.updatedAt, timezone, locale)}
                </span>
                <Button
                  variant="tertiary"
                  aria-label={t('cities.forgetCity', { city: name.city })}
                  disabled={forget.isPending}
                  onClick={() => void onForget(name.city)}
                >
                  {t('cities.forget')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="font-semibold">{t('cities.lookUp')}</h2>
        <form onSubmit={onLookUp} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('cities.lookUpField')}
            value={words}
            onChange={(event) => setWords(event.target.value)}
            dir="auto"
            className="min-w-0 flex-1"
            required
          />
          <Button
            type="submit"
            variant="secondary"
            icon={<Search aria-hidden className="size-5" />}
          >
            {t('cities.lookUpButton')}
          </Button>
        </form>
        {looked && (
          <CityMatch
            key={looked}
            accountId={accountId}
            courierName={courier}
            city={looked}
            saveLabel={t('cities.keep')}
            onSaved={(match) => {
              setSaid(
                t('cities.kept', {
                  courier,
                  city: match.city,
                  courierCity: match.courierCity ?? '',
                }),
              );
              setLooked('');
              setWords('');
            }}
          />
        )}
      </Card>
    </div>
  );
}
