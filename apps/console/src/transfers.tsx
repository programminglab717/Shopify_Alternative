import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { DecisionForm, problemOf, useDecision } from './decide';
import type { BillingTransfer, StatementMatched } from './types';
import { Alert, Button, Card, when } from './ui';

/** What became of a transfer confirmed, in a line. */
const OUTCOMES: Record<string, (invoice: string, left: string) => string> = {
  paid: (invoice) => `Confirmed: invoice ${invoice} is paid, and the shop's owner is told.`,
  short: (invoice, left) => `Confirmed: invoice ${invoice} waits for ${left} more.`,
  already_paid: (invoice) =>
    `Confirmed, but invoice ${invoice} was paid otherwise already: what came is Hatti's to give back.`,
};

function Confirm({ transfer }: { transfer: BillingTransfer }) {
  const id = useId();
  const [received, setReceived] = useState('');
  const confirm = useDecision<{ transfer: { outcome: string; invoiceName: string; left: string } }>(
    `/billing-transfers/${transfer.id}/confirm`,
    [['billing-transfers']],
  );
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-medium">
        What came, in rupees, if not {transfer.amount}
      </label>
      <input
        id={id}
        inputMode="decimal"
        value={received}
        onChange={(event) => setReceived(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {confirm.isError && <Alert tone="danger">{problemOf(confirm.error)}</Alert>}
      {confirm.isSuccess && (
        <Alert tone="success">
          {(OUTCOMES[confirm.data.transfer.outcome] ?? OUTCOMES.paid!)(
            confirm.data.transfer.invoiceName,
            confirm.data.transfer.left,
          )}
        </Alert>
      )}
      <Button
        className="self-start"
        busy={confirm.isPending}
        onClick={() => confirm.mutate(received.trim() ? { received } : {})}
      >
        Found it: confirm
      </Button>
    </div>
  );
}

const OUTCOME_WORDS = {
  exact: 'as said',
  short: 'less than said',
  over: 'more than said',
} as const;

/** Confirms a matched transfer for what its credit brought. */
function ConfirmMatch({ match }: { match: StatementMatched['matches'][number] }) {
  const confirm = useDecision<{ transfer: { outcome: string; invoiceName: string; left: string } }>(
    `/billing-transfers/${match.transfer.id}/confirm`,
    [['billing-transfers']],
  );
  if (confirm.isSuccess) {
    return (
      <Alert tone="success">
        {(OUTCOMES[confirm.data.transfer.outcome] ?? OUTCOMES.paid!)(
          confirm.data.transfer.invoiceName,
          confirm.data.transfer.left,
        )}
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {confirm.isError && <Alert tone="danger">{problemOf(confirm.error)}</Alert>}
      <Button
        className="self-start"
        busy={confirm.isPending}
        onClick={() => confirm.mutate({ received: match.credit.received })}
      >
        Confirm for {match.credit.amount}
      </Button>
    </div>
  );
}

/**
 * Hatti's bank statement, as the bank exports it in CSV, matched against the transfers waiting
 * (ADR-883): each match confirmed by Hatti's people, one by one.
 */
function Statement() {
  const id = useId();
  const [matched, setMatched] = useState<StatementMatched | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    setMatched(null);
    try {
      const csv = await file.text();
      setMatched(
        await consoleCall<StatementMatched>('/billing-transfers/statement', {
          method: 'POST',
          body: { csv },
        }),
      );
    } catch (failure) {
      setProblem(problemOf(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Match from Hatti&rsquo;s bank statement</h2>
      <p className="text-secondary">
        Export the statement from the bank as CSV (from Excel, save it as CSV first). Each credit
        carrying a waiting transfer&rsquo;s reference is matched to it; confirm each yourself.
      </p>
      <label htmlFor={id} className="font-medium">
        The statement
      </label>
      <input
        id={id}
        type="file"
        accept=".csv,text/csv"
        disabled={busy}
        onChange={(event) => void read(event.target.files?.[0])}
      />
      {busy && <p>Reading…</p>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {matched && (
        <div className="flex flex-col gap-3">
          <p>
            {matched.credits} credit{matched.credits === 1 ? '' : 's'} read;{' '}
            {matched.matches.length} matched.
          </p>
          {matched.matches.map((match) => (
            <section
              key={match.transfer.id}
              className="flex flex-col gap-1 rounded-card border border-line p-3"
            >
              <h3 className="font-semibold">
                {match.transfer.shop.name}: {match.transfer.reference}
              </h3>
              <p>
                {match.credit.amount} came {match.credit.date ? `on ${match.credit.date}` : ''},{' '}
                {OUTCOME_WORDS[match.outcome]} ({match.transfer.amount} was said)
              </p>
              <p className="text-secondary">{match.credit.description}</p>
              <ConfirmMatch match={match} />
            </section>
          ))}
          {matched.ambiguous.length > 0 && (
            <Alert tone="warning">
              More than one credit carries the reference of{' '}
              {matched.ambiguous.map((each) => `${each.shop.name} (${each.reference})`).join(', ')}:
              find them by hand.
            </Alert>
          )}
          {matched.unmatched.length > 0 && (
            <details>
              <summary>
                {matched.unmatched.length + matched.moreUnmatched} credit
                {matched.unmatched.length + matched.moreUnmatched === 1 ? '' : 's'} matched nothing
              </summary>
              <ul className="flex flex-col gap-1 pt-2">
                {matched.unmatched.map((credit) => (
                  <li key={credit.row}>
                    {credit.date} · {credit.amount} · {credit.description}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

/** Transfers shops said they made into Hatti's account, to find there (ADR-254). */
export function TransfersPage() {
  const transfers = useQuery({
    queryKey: ['billing-transfers'],
    queryFn: () => consoleCall<{ transfers: BillingTransfer[] }>('/billing-transfers'),
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Transfers to Hatti</h1>
      <p className="text-secondary">
        Find each in Hatti&rsquo;s bank account by its reference. Confirming one pays its invoice;
        refusing tells the shop&rsquo;s owner why.
      </p>
      <Statement />
      {transfers.isPending ? (
        <p>Loading…</p>
      ) : transfers.isError ? (
        <Alert tone="danger">{errorText(transfers.error)}</Alert>
      ) : transfers.data.transfers.length === 0 ? (
        <p className="text-secondary">No transfer waits.</p>
      ) : (
        transfers.data.transfers.map((transfer) => (
          <Card key={transfer.id} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">
              {transfer.amount} from {transfer.shop.name}
            </h2>
            <p>
              Reference <code className="text-lg">{transfer.reference}</code> · invoice{' '}
              {transfer.invoiceName}
            </p>
            <p className="text-secondary">Said {when(transfer.reportedAt)}</p>
            <Confirm transfer={transfer} />
            <DecisionForm
              label="Not found: why, as the shop's owner is told"
              name="reason"
              actions={[
                {
                  label: 'Refuse',
                  path: `/billing-transfers/${transfer.id}/refuse`,
                  refresh: [['billing-transfers']],
                  done: "Refused: the shop's owner is told why, and may say another transfer.",
                  variant: 'secondary',
                },
              ]}
            />
          </Card>
        ))
      )}
    </div>
  );
}
