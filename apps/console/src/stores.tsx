import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { DecisionForm, REASONS, ShowAll, problemOf, useDecision } from './decide';
import type { StoreAppeal, Takedown } from './types';
import { Alert, Button, Card, when } from './ui';

/** Takes a store down by its handle: why, as its owner is told, with the link to appeal by. */
function TakeDown({ shop, reason: suggested }: { shop?: string; reason?: string }) {
  const id = useId();
  const [handle, setHandle] = useState(shop ?? '');
  const [reason, setReason] = useState(suggested && REASONS[suggested] ? suggested : 'scam');
  const [note, setNote] = useState('');
  const takeDown = useDecision<{ takedown: Takedown }>(
    `/shops/${encodeURIComponent(handle.trim())}/suspend`,
    [['takedowns']],
  );
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Take a store down</h2>
      <p className="text-secondary">
        Its owner is told why first, with a link to appeal; then its storefront says it is down.
      </p>
      <label htmlFor={`${id}-shop`} className="font-medium">
        Store&rsquo;s handle
      </label>
      <input
        id={`${id}-shop`}
        value={handle}
        onChange={(event) => setHandle(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      <label htmlFor={`${id}-reason`} className="font-medium">
        Why
      </label>
      <select
        id={`${id}-reason`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      >
        {Object.entries(REASONS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-note`} className="font-medium">
        What its owner is told
      </label>
      <textarea
        id={`${id}-note`}
        rows={2}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {takeDown.isError && <Alert tone="danger">{problemOf(takeDown.error)}</Alert>}
      {takeDown.isSuccess && (
        <Alert tone="success">{takeDown.data.takedown.shop.name} is down; its owner is told.</Alert>
      )}
      <Button
        className="self-start"
        busy={takeDown.isPending}
        disabled={!handle.trim()}
        onClick={() => takeDown.mutate({ reason, note })}
      >
        Take it down
      </Button>
    </Card>
  );
}

/** Stores down and their owners' appeals (ADR-461, ADR-462): restored, or the appeal refused. */
export function StoresPage() {
  const search = useSearch({ from: '/agent/stores' });
  const [all, setAll] = useState(false);
  const takedowns = useQuery({
    queryKey: ['takedowns', all],
    queryFn: () => consoleCall<{ takedowns: Takedown[] }>(`/takedowns${all ? '?all=1' : ''}`),
  });
  const appeals = useQuery({
    queryKey: ['appeals'],
    queryFn: () => consoleCall<{ appeals: StoreAppeal[] }>('/appeals'),
  });
  const waitingOf = (handle: string) =>
    appeals.data?.appeals.find((each) => each.shop.handle === handle);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Stores down</h1>
        <ShowAll all={all} onChange={setAll} />
      </div>
      <TakeDown shop={search.shop} reason={search.reason} />
      {takedowns.isPending ? (
        <p>Loading…</p>
      ) : takedowns.isError ? (
        <Alert tone="danger">{errorText(takedowns.error)}</Alert>
      ) : takedowns.data.takedowns.length === 0 ? (
        <p className="text-secondary">{all ? 'No store taken down yet.' : 'No store is down.'}</p>
      ) : (
        takedowns.data.takedowns.map((takedown) => {
          const appeal = takedown.restoredAt ? undefined : waitingOf(takedown.shop.handle);
          return (
            <Card key={`${takedown.shop.id}-${takedown.createdAt}`} className="flex flex-col gap-2">
              <h2 className="text-lg font-semibold">
                {takedown.shop.name}{' '}
                <span className="text-secondary">({takedown.shop.handle})</span>
              </h2>
              <p className="text-secondary">
                {REASONS[takedown.reason] ?? takedown.reason} · down since{' '}
                {when(takedown.createdAt)} · by {takedown.takenBy}
              </p>
              <p>{takedown.note}</p>
              {takedown.restoredAt ? (
                <p className="text-secondary">
                  Restored {when(takedown.restoredAt)} by {takedown.restoredBy}:{' '}
                  {takedown.restoreNote}
                </p>
              ) : (
                <>
                  {appeal && (
                    <section className="flex flex-col gap-2 rounded-card border border-line p-3">
                      <h3 className="font-semibold">Its owner appeals</h3>
                      <p className="whitespace-pre-wrap">{appeal.words}</p>
                      <p className="text-secondary">Since {when(appeal.createdAt)}</p>
                      <DecisionForm
                        label="Why the appeal is refused, as its owner is told"
                        name="answer"
                        actions={[
                          {
                            label: 'Refuse the appeal',
                            path: `/appeals/${appeal.id}/refuse`,
                            refresh: [['appeals']],
                            done: 'Refused; its owner is told.',
                            variant: 'secondary',
                          },
                        ]}
                      />
                    </section>
                  )}
                  <DecisionForm
                    label="Why it is open again, as its owner is told"
                    name="note"
                    actions={[
                      {
                        label: 'Restore the store',
                        path: `/shops/${encodeURIComponent(takedown.shop.handle)}/restore`,
                        refresh: [['takedowns'], ['appeals']],
                        done: 'Open again; its owner is told.',
                      },
                    ]}
                  />
                </>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
