import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { consoleCall, errorText } from './api';
import type { SupportAccess } from './types';
import { Alert, Card, when } from './ui';

/**
 * Shops whose owners let support look now (ADR-882), the soonest to end first: open each in the
 * admin, signed in there as an agent. Support reads alone, and each look is on the shop's log.
 */
export function AccessPage() {
  const open = useQuery({
    queryKey: ['support-access'],
    queryFn: () => consoleCall<{ shops: SupportAccess[] }>('/support-access'),
    refetchInterval: 60_000,
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Open to support</h1>
      <p className="text-secondary">
        Shops whose owners let support look now. Look in the admin, signed in there as an agent: you
        read alone, numbers masked, and each look is on the shop&rsquo;s activity log.
      </p>
      {open.isPending ? (
        <p>Loading…</p>
      ) : open.isError ? (
        <Alert tone="danger">{errorText(open.error)}</Alert>
      ) : open.data.shops.length === 0 ? (
        <p className="text-secondary">No shop lets support look now.</p>
      ) : (
        open.data.shops.map((each) => (
          <Card key={each.shop.id} className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">
              <Link to="/shops/$shopId" params={{ shopId: each.shop.id }} className="underline">
                {each.shop.name}
              </Link>{' '}
              <span className="text-secondary">({each.shop.handle})</span>
            </h2>
            {each.note && <p>{each.note}</p>}
            <p className="text-secondary">
              {each.grantedBy} allowed it {when(each.since)}, until {when(each.until)}
            </p>
            {each.adminUrl && (
              <a
                href={each.adminUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="self-start underline"
              >
                Look in the admin
              </a>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
