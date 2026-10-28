import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { consoleCall, errorText } from './api';
import { problemOf, useDecision } from './decide';
import type { ExpertProfile, PartnerApp, PartnerOwed, PartnerTheme } from './types';
import { Alert, Button, Card } from './ui';

/** A listing's review: listed for every shop once checked, or taken back. */
function Review({ path, listed, refresh }: { path: string; listed: boolean; refresh: string }) {
  const review = useDecision<unknown>(`${path}/${listed ? 'unlist' : 'list'}`, [[refresh]]);
  return (
    <div className="flex flex-col gap-2">
      {review.isError && <Alert tone="danger">{problemOf(review.error)}</Alert>}
      <Button
        className="self-start"
        variant={listed ? 'secondary' : 'primary'}
        busy={review.isPending}
        onClick={() => review.mutate({})}
      >
        {listed ? 'Take it back' : 'Checked: list it'}
      </Button>
    </div>
  );
}

function Section<T>({
  title,
  query,
  empty,
  render,
}: {
  title: string;
  query: { isPending: boolean; isError: boolean; error: unknown; data?: T[] };
  empty: string;
  render: (item: T) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      {query.isPending ? (
        <p>Loading…</p>
      ) : query.isError ? (
        <Alert tone="danger">{errorText(query.error)}</Alert>
      ) : (query.data ?? []).length === 0 ? (
        <p className="text-secondary">{empty}</p>
      ) : (
        (query.data ?? []).map(render)
      )}
    </section>
  );
}

const status = (listed: boolean) => (
  <span className={listed ? 'text-success' : 'font-semibold text-warning'}>
    {listed ? 'Listed' : 'Waiting for review'}
  </span>
);

/**
 * Partners' work for every shop (ADR-851, ADR-853, ADR-855), each checked against the review list
 * in docs/developers/README.md before it is listed.
 */
export function PartnersPage() {
  const apps = useQuery({
    queryKey: ['partner-apps'],
    queryFn: async () => (await consoleCall<{ apps: PartnerApp[] }>('/partner-apps')).apps,
  });
  const themes = useQuery({
    queryKey: ['partner-themes'],
    queryFn: async () => (await consoleCall<{ themes: PartnerTheme[] }>('/partner-themes')).themes,
  });
  const experts = useQuery({
    queryKey: ['experts'],
    queryFn: async () => (await consoleCall<{ experts: ExpertProfile[] }>('/experts')).experts,
  });
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Partners&rsquo; work</h1>
      <p className="text-secondary">
        Check each against the review list in docs/developers/README.md before listing it.
      </p>
      <Section
        title="Apps"
        query={apps}
        empty="No partner has registered an app."
        render={(app: PartnerApp) => (
          <Card key={app.clientId} className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold">
              {app.name} <span className="text-secondary">by {app.partner}</span>
            </h3>
            <p>{status(app.listed)}</p>
            <p>
              <a href={app.appUrl} target="_blank" rel="noreferrer noopener" className="underline">
                {app.appUrl}
              </a>
            </p>
            <p className="text-secondary">Asks for {app.scopes.join(', ')}</p>
            <p className="text-secondary">Sends merchants back to {app.redirectUrls.join(', ')}</p>
            <Review
              path={`/partner-apps/${app.clientId}`}
              listed={app.listed}
              refresh="partner-apps"
            />
          </Card>
        )}
      />
      <Section
        title="Themes"
        query={themes}
        empty="No designer has offered a theme."
        render={(theme: PartnerTheme) => (
          <Card key={theme.id} className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold">
              {theme.name} <span className="text-secondary">by {theme.designer}</span>
            </h3>
            <p>
              {status(theme.listed)} · {theme.price ?? 'Free'} · on {theme.base}
            </p>
            <p>{theme.description}</p>
            <p className="text-secondary">
              Preview it on its development store {theme.preview.shopId}, theme{' '}
              {theme.preview.themeId}
            </p>
            <Review
              path={`/partner-themes/${theme.id}`}
              listed={theme.listed}
              refresh="partner-themes"
            />
          </Card>
        )}
      />
      <Section
        title="Experts"
        query={experts}
        empty="No partner has made an expert profile."
        render={(expert: ExpertProfile) => (
          <Card key={expert.id} className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold">{expert.businessName}</h3>
            <p>
              {status(expert.listed)}
              {expert.certified && ' · Certified'}
            </p>
            <p className="font-medium">{expert.headline}</p>
            <p className="whitespace-pre-wrap">{expert.about}</p>
            <p className="text-secondary">
              {expert.services.join(', ')} · {expert.cities.join(', ') || 'anywhere'} ·{' '}
              {expert.languages.join(', ')} ·{' '}
              {expert.startingPrice ? `from ${expert.startingPrice}` : 'ask'}
              {expert.website && ` · ${expert.website}`}
            </p>
            <Review path={`/experts/${expert.id}`} listed={expert.listed} refresh="experts" />
          </Card>
        )}
      />
    </div>
  );
}

function Pay({ partner }: { partner: PartnerOwed }) {
  const id = useId();
  const [reference, setReference] = useState('');
  const pay = useDecision<{ paid: string; nothingOwed: boolean }>(
    `/partner-payouts/${partner.id}/pay`,
    [['partner-payouts']],
  );
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-medium">
        The bank transfer&rsquo;s reference
      </label>
      <input
        id={id}
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {pay.isError && <Alert tone="danger">{problemOf(pay.error)}</Alert>}
      {pay.isSuccess && (
        <Alert tone="success">
          {pay.data.nothingOwed
            ? 'They were owed nothing: nothing marked.'
            : `Marked ${pay.data.paid} paid.`}
        </Alert>
      )}
      <Button className="self-start" busy={pay.isPending} onClick={() => pay.mutate({ reference })}>
        Transferred: mark it paid
      </Button>
    </div>
  );
}

/** Partners owed their share of what their stores paid Hatti (ADR-505). */
export function PayoutsPage() {
  const owed = useQuery({
    queryKey: ['partner-payouts'],
    queryFn: () => consoleCall<{ partners: PartnerOwed[] }>('/partner-payouts'),
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Partner payouts</h1>
      <p className="text-secondary">
        Transfer what each is owed from Hatti&rsquo;s bank account, then mark it paid with the
        transfer&rsquo;s reference.
      </p>
      {owed.isPending ? (
        <p>Loading…</p>
      ) : owed.isError ? (
        <Alert tone="danger">{errorText(owed.error)}</Alert>
      ) : owed.data.partners.length === 0 ? (
        <p className="text-secondary">No partner is owed anything.</p>
      ) : (
        owed.data.partners.map((partner) => (
          <Card key={partner.id} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">
              {partner.owed} to {partner.businessName}
            </h2>
            <p className="text-secondary">
              {partner.email} · {partner.entries} invoice{partner.entries === 1 ? '' : 's'}
            </p>
            <p>
              {partner.payout ? (
                <>
                  Into {partner.payout.title}, <code>{partner.payout.iban}</code>
                </>
              ) : (
                <span className="text-warning">No bank account given yet: ask them for one.</span>
              )}
            </p>
            {partner.payout && <Pay partner={partner} />}
          </Card>
        ))
      )}
    </div>
  );
}
