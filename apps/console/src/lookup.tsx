import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { consoleCall, errorText } from './api';
import type { ShopFound, ShopStanding } from './types';
import { Alert, Button, Card, when } from './ui';

/** Finds a shop by its name, handle or ID. */
export function ShopsPage() {
  const search = useSearch({ from: '/agent/shops' });
  const navigate = useNavigate();
  const [query, setQuery] = useState(search.query ?? '');
  const found = useQuery({
    queryKey: ['shops', search.query],
    enabled: Boolean(search.query && search.query.length >= 2),
    queryFn: () =>
      consoleCall<{ shops: ShopFound[] }>(`/shops?query=${encodeURIComponent(search.query!)}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Shops</h1>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ to: '/shops', search: { query: query.trim() || undefined } });
        }}
      >
        <label className="flex grow flex-col gap-1">
          <span className="font-medium">Name, handle or ID</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="rounded-control border border-line bg-surface p-2"
          />
        </label>
        <Button type="submit">Find</Button>
      </form>
      {!search.query ? null : found.isPending ? (
        <p>Looking…</p>
      ) : found.isError ? (
        <Alert tone="danger">{errorText(found.error)}</Alert>
      ) : found.data.shops.length === 0 ? (
        <p className="text-secondary">No shop is called that.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
          {found.data.shops.map((shop) => (
            <li key={shop.id} className="flex flex-wrap items-baseline justify-between gap-2 p-3">
              <Link
                to="/shops/$shopId"
                params={{ shopId: shop.id }}
                className="font-medium underline"
              >
                {shop.name}
              </Link>
              <span className="text-secondary">
                {shop.handle} · {shop.plan} · {shop.status}
                {shop.development && ' · development store'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col">
    <dt className="text-secondary">{label}</dt>
    <dd className="font-medium">{children}</dd>
  </div>
);

/** A shop's standing: its owner, what waits of it, and what was done to it here. */
export function ShopPage() {
  const { shopId } = useParams({ from: '/agent/shops/$shopId' });
  const standing = useQuery({
    queryKey: ['shop', shopId],
    queryFn: () => consoleCall<ShopStanding>(`/shops/${shopId}`),
  });
  if (standing.isPending) return <p>Loading…</p>;
  if (standing.isError) return <Alert tone="danger">{errorText(standing.error)}</Alert>;
  const { shop, owner } = standing.data;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">
        {shop.name} <span className="text-secondary">({shop.handle})</span>
      </h1>
      {standing.data.downSince && (
        <Alert tone="danger">Down since {when(standing.data.downSince)}.</Alert>
      )}
      <Card>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Fact label="Status">{shop.status}</Fact>
          <Fact label="Plan">{shop.plan}</Fact>
          <Fact label="Opened">{when(shop.createdAt)}</Fact>
          <Fact label="Owner">
            {owner ? (
              <>
                {owner.name}
                {owner.email && <span className="block font-normal">{owner.email}</span>}
                {owner.phone && <span className="block font-normal">{owner.phone}</span>}
              </>
            ) : (
              'None'
            )}
          </Fact>
          <Fact label="Verified">
            {standing.data.verified.length > 0 ? standing.data.verified.join(' and ') : 'Not yet'}
          </Fact>
          <Fact label="Support may look">
            {standing.data.supportAccess
              ? `Until ${when(standing.data.supportAccess.until)}${
                  standing.data.supportAccess.note ? `: ${standing.data.supportAccess.note}` : ''
                }`
              : 'No'}
          </Fact>
        </dl>
      </Card>
      <Card className="flex flex-wrap gap-4">
        <Link to="/reports" className="underline">
          {standing.data.openReports} report{standing.data.openReports === 1 ? '' : 's'} open
        </Link>
        <Link to="/support" className="underline">
          {standing.data.openSupportRequests} support request
          {standing.data.openSupportRequests === 1 ? '' : 's'} waiting
        </Link>
        <Link to="/signals" className="underline">
          {standing.data.standingSignals} sign{standing.data.standingSignals === 1 ? '' : 's'} of a
          scam
        </Link>
        <Link to="/stores" search={{ shop: shop.handle }} className="text-danger underline">
          Take it down
        </Link>
      </Card>
      <h2 className="text-xl font-semibold">Done here</h2>
      {standing.data.actions.length === 0 ? (
        <p className="text-secondary">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
          {standing.data.actions.map((action) => (
            <li key={`${action.at}-${action.action}`} className="flex flex-col p-3">
              <span className="font-medium">{action.action}</span>
              <span className="text-secondary">
                {action.email} · {when(action.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
