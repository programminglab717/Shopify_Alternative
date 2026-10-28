import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { DecisionForm, problemOf, useDecision } from './decide';
import type { BillingTransfer } from './types';
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
