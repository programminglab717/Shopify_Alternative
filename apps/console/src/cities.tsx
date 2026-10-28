import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { problemOf, useDecision } from './decide';
import type { CourierCities } from './types';
import { Alert, Button, Card } from './ui';

function Keep({ courier, city: given }: { courier: string; city?: string }) {
  const id = useId();
  const [city, setCity] = useState(given ?? '');
  const [courierCity, setCourierCity] = useState('');
  const keep = useDecision<unknown>(`/courier-cities/${courier}/keep`, [
    ['courier-cities', courier],
  ]);
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Keep Hatti&rsquo;s name for a city</h2>
      <p className="text-secondary">
        It comes before any name shops agree on, so it settles a city they named wrong.
      </p>
      <label htmlFor={`${id}-city`} className="font-medium">
        City, as shops write it
      </label>
      <input
        id={`${id}-city`}
        value={city}
        onChange={(event) => setCity(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      <label htmlFor={`${id}-courier`} className="font-medium">
        The courier&rsquo;s name for it
      </label>
      <input
        id={`${id}-courier`}
        value={courierCity}
        onChange={(event) => setCourierCity(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {keep.isError && <Alert tone="danger">{problemOf(keep.error)}</Alert>}
      {keep.isSuccess && (
        <Alert tone="success">
          Every shop&rsquo;s parcels to {city} go to {courier} as {courierCity}.
        </Alert>
      )}
      <Button
        className="self-start"
        busy={keep.isPending}
        onClick={() => keep.mutate({ city, courierCity })}
      >
        Keep it
      </Button>
    </Card>
  );
}

function Forget({ courier, city }: { courier: string; city: string }) {
  const forget = useDecision<unknown>(`/courier-cities/${courier}/forget`, [
    ['courier-cities', courier],
  ]);
  return (
    <Button variant="secondary" busy={forget.isPending} onClick={() => forget.mutate({ city })}>
      Forget
    </Button>
  );
}

/** Couriers' names for cities across shops (ADR-260), and Hatti's own. */
export function CitiesPage() {
  const couriers = useQuery({
    queryKey: ['courier-cities'],
    queryFn: () => consoleCall<{ couriers: string[] }>('/courier-cities'),
  });
  const [courier, setCourier] = useState('');
  const chosen = courier || couriers.data?.couriers[0] || '';
  const cities = useQuery({
    queryKey: ['courier-cities', chosen],
    enabled: Boolean(chosen),
    queryFn: () => consoleCall<CourierCities>(`/courier-cities/${chosen}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Couriers&rsquo; city names</h1>
      {couriers.isPending ? (
        <p>Loading…</p>
      ) : couriers.isError ? (
        <Alert tone="danger">{errorText(couriers.error)}</Alert>
      ) : couriers.data.couriers.length === 0 ? (
        <p className="text-secondary">No shop has named a city with a courier yet.</p>
      ) : (
        <>
          <label className="flex flex-col gap-1 self-start">
            <span className="font-medium">Courier</span>
            <select
              value={chosen}
              onChange={(event) => setCourier(event.target.value)}
              className="rounded-control border border-line bg-surface p-2"
            >
              {couriers.data.couriers.map((each) => (
                <option key={each} value={each}>
                  {each}
                </option>
              ))}
            </select>
          </label>
          {cities.isPending ? (
            <p>Loading…</p>
          ) : cities.isError ? (
            <Alert tone="danger">{errorText(cities.error)}</Alert>
          ) : (
            <>
              <h2 className="text-xl font-semibold">Hatti&rsquo;s names, which come first</h2>
              {cities.data.hatti.length === 0 ? (
                <p className="text-secondary">None.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
                  {cities.data.hatti.map((name) => (
                    <li key={name.city} className="flex items-center justify-between gap-2 p-3">
                      <span>
                        {name.city} → <code>{name.courierCity}</code>
                      </span>
                      <Forget courier={chosen} city={name.city} />
                    </li>
                  ))}
                </ul>
              )}
              <h2 className="text-xl font-semibold">Shops&rsquo; names</h2>
              {cities.data.shops.length === 0 ? (
                <p className="text-secondary">None.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
                  {cities.data.shops.map((entry) => (
                    <li key={entry.cityKey} className="flex flex-col p-3">
                      <span className="font-medium">{entry.city}</span>
                      <span className="text-secondary">
                        {entry.names
                          .map((name) => `${name.courierCity} (${name.shops})`)
                          .join(', ')}{' '}
                        ·{' '}
                        {entry.shared
                          ? 'shared'
                          : entry.names.length > 1
                            ? 'disputed'
                            : 'not yet shared'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Keep key={chosen} courier={chosen} />
            </>
          )}
        </>
      )}
    </div>
  );
}
