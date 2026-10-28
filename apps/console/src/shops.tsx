import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { DecisionForm, ShowAll, problemOf, useDecision } from './decide';
import type { SmsSender, StoreSignal } from './types';
import { Alert, Button, Card, when } from './ui';

/** What each sign of a scam store is, in Hatti's people's words. */
const SIGNS: Record<StoreSignal['kind'], string> = {
  prepaid_unshipped: 'A young store keeping paid orders unshipped',
  cloned_catalogue: 'A catalogue copied from an older store',
  impersonation: "A name that is a verified store's",
};

/** Signs of scam stores the worker found (ADR-842): each looked into, and cleared when nothing. */
export function SignalsPage() {
  const [all, setAll] = useState(false);
  const signals = useQuery({
    queryKey: ['signals', all],
    queryFn: () => consoleCall<{ signals: StoreSignal[] }>(`/signals${all ? '?all=1' : ''}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Signs of scam stores</h1>
        <ShowAll all={all} onChange={setAll} />
      </div>
      {signals.isPending ? (
        <p>Loading…</p>
      ) : signals.isError ? (
        <Alert tone="danger">{errorText(signals.error)}</Alert>
      ) : signals.data.signals.length === 0 ? (
        <p className="text-secondary">{all ? 'No sign found yet.' : 'No sign stands.'}</p>
      ) : (
        signals.data.signals.map((signal) => (
          <Card key={`${signal.shop.id}-${signal.kind}`} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">
              {signal.shop.name} <span className="text-secondary">({signal.shop.handle})</span>
            </h2>
            <p className="font-medium">{SIGNS[signal.kind] ?? signal.kind}</p>
            <p className="text-secondary">
              First seen {when(signal.firstSeenAt)}, last {when(signal.lastSeenAt)}
            </p>
            <pre className="overflow-x-auto rounded-control bg-canvas p-2 text-sm">
              {JSON.stringify(signal.detail, null, 2)}
            </pre>
            {signal.clearedAt ? (
              <p className="text-secondary">
                Cleared by {signal.clearedBy}: {signal.note}
              </p>
            ) : (
              <DecisionForm
                label="Why it is nothing"
                name="note"
                actions={[
                  {
                    label: 'Clear it',
                    path: `/shops/${encodeURIComponent(signal.shop.handle)}/signals/${signal.kind}/clear`,
                    refresh: [['signals']],
                    done: 'Cleared: it is not raised again.',
                    variant: 'secondary',
                  },
                ]}
              />
            )}
          </Card>
        ))
      )}
    </div>
  );
}

/** Takes back the name a shop sends its SMS from. */
function TakeBackSender() {
  const id = useId();
  const [handle, setHandle] = useState('');
  const [answer, setAnswer] = useState('');
  const revoke = useDecision<{ sender: SmsSender }>(
    `/shops/${encodeURIComponent(handle.trim())}/sms-sender/revoke`,
    [['sms-senders']],
  );
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Take a sender name back</h2>
      <label htmlFor={`${id}-shop`} className="font-medium">
        Store&rsquo;s handle
      </label>
      <input
        id={`${id}-shop`}
        value={handle}
        onChange={(event) => setHandle(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      <label htmlFor={`${id}-answer`} className="font-medium">
        Why, as the shop is told
      </label>
      <textarea
        id={`${id}-answer`}
        rows={2}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {revoke.isError && <Alert tone="danger">{problemOf(revoke.error)}</Alert>}
      {revoke.isSuccess && (
        <Alert tone="success">{revoke.data.sender.name} is taken back; the shop is told.</Alert>
      )}
      <Button
        variant="secondary"
        className="self-start"
        busy={revoke.isPending}
        disabled={!handle.trim()}
        onClick={() => revoke.mutate({ answer })}
      >
        Take it back
      </Button>
    </Card>
  );
}

/** Shops' own SMS sender names (ADR-469), approved once operators register them. */
export function SendersPage() {
  const [all, setAll] = useState(false);
  const senders = useQuery({
    queryKey: ['sms-senders', all],
    queryFn: () => consoleCall<{ senders: SmsSender[] }>(`/sms-senders${all ? '?all=1' : ''}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">SMS sender names</h1>
        <ShowAll all={all} onChange={setAll} />
      </div>
      <p className="text-secondary">
        Approve a name once the operators have registered it for the shop, which Hatti must have
        verified.
      </p>
      {senders.isPending ? (
        <p>Loading…</p>
      ) : senders.isError ? (
        <Alert tone="danger">{errorText(senders.error)}</Alert>
      ) : senders.data.senders.length === 0 ? (
        <p className="text-secondary">
          {all ? 'No sender name asked for yet.' : 'No sender name is waiting.'}
        </p>
      ) : (
        senders.data.senders.map((sender) => (
          <Card key={sender.id} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">
              <code>{sender.name}</code> for {sender.shop.name}{' '}
              <span className="text-secondary">({sender.shop.handle})</span>
            </h2>
            <p className="text-secondary">
              Asked {when(sender.createdAt)}
              {sender.status !== 'waiting' &&
                ` · ${sender.status} by ${sender.decidedBy ?? '?'}${sender.answer ? `: ${sender.answer}` : ''}`}
            </p>
            {sender.status === 'waiting' && (
              <DecisionForm
                label="A note, or why it is refused (the shop reads it)"
                name="answer"
                required={false}
                actions={[
                  {
                    label: 'Approve',
                    path: `/sms-senders/${sender.id}/approve`,
                    refresh: [['sms-senders']],
                    done: 'Approved: the shop’s SMS go from it, and the shop is told.',
                  },
                  {
                    label: 'Refuse',
                    path: `/sms-senders/${sender.id}/refuse`,
                    refresh: [['sms-senders']],
                    done: 'Refused; the shop is told.',
                    variant: 'secondary',
                  },
                ]}
              />
            )}
          </Card>
        ))
      )}
      <TakeBackSender />
    </div>
  );
}
