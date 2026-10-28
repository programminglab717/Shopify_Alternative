import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { DecisionForm, ShowAll, problemOf, useDecision } from './decide';
import type { RightsComplaint } from './types';
import { Alert, Button, Card, when } from './ui';

function Complaint({ complaint }: { complaint: RightsComplaint }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {complaint.shop.name} <span className="text-secondary">({complaint.shop.handle})</span>
        </h2>
        <span className={complaint.overdue ? 'font-semibold text-danger' : 'text-secondary'}>
          {complaint.status !== 'open'
            ? `${complaint.status} by ${complaint.decidedBy ?? '?'}`
            : complaint.overdue
              ? `Overdue: was due ${when(complaint.dueAt)}`
              : `Due ${when(complaint.dueAt)}`}
        </span>
      </div>
      <p className="font-medium">
        {complaint.kind} of {complaint.rightsOwner}
        {complaint.registration && ` (${complaint.registration})`}
      </p>
      <p className="text-secondary">
        {complaint.complainant} ({complaint.actingAs}) · {complaint.email}
        {complaint.phone && ` · ${complaint.phone}`} · sworn as {complaint.signature}
      </p>
      <p lang={complaint.language} className="whitespace-pre-wrap">
        {complaint.details}
      </p>
      <ul className="list-disc pl-5">
        {complaint.listings.map((listing) => (
          <li key={listing.id}>
            <a href={listing.url} target="_blank" rel="noreferrer noopener" className="underline">
              {listing.title}
            </a>{' '}
            <code className="text-secondary">{listing.id}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Clears a listing the screening for goods Hatti doesn't allow found by mistake (ADR-473). */
function ClearListing() {
  const id = useId();
  const [product, setProduct] = useState('');
  const clear = useDecision<{ product: { title: string; found: string[] } }>(
    `/products/${encodeURIComponent(product.trim())}/clear-screening`,
    [],
  );
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Clear a listing held as prohibited</h2>
      <p className="text-secondary">
        For a product the screening for goods Hatti doesn&rsquo;t allow found by mistake: it may go
        on sale until its words change.
      </p>
      <label htmlFor={id} className="font-medium">
        Product&rsquo;s ID
      </label>
      <input
        id={id}
        value={product}
        placeholder="prod_…"
        onChange={(event) => setProduct(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {clear.isError && <Alert tone="danger">{problemOf(clear.error)}</Alert>}
      {clear.isSuccess && (
        <Alert tone="success">
          {clear.data.product.title} is cleared
          {clear.data.product.found.length > 0 &&
            ` (it named ${clear.data.product.found.join(', ')})`}
          .
        </Alert>
      )}
      <Button
        variant="secondary"
        className="self-start"
        busy={clear.isPending}
        disabled={!product.trim()}
        onClick={() => clear.mutate({})}
      >
        Clear it
      </Button>
    </Card>
  );
}

/** Rights owners' complaints of stores' listings, and the stores' owners' answers. */
export function RightsPage() {
  const [all, setAll] = useState(false);
  const complaints = useQuery({
    queryKey: ['rights', all],
    queryFn: () => consoleCall<{ complaints: RightsComplaint[] }>(`/rights${all ? '?all=1' : ''}`),
  });
  const answers = useQuery({
    queryKey: ['rights-answers'],
    queryFn: () => consoleCall<{ complaints: RightsComplaint[] }>('/rights-answers'),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Rights complaints</h1>
        <ShowAll all={all} onChange={setAll} />
      </div>
      {complaints.isPending ? (
        <p>Loading…</p>
      ) : complaints.isError ? (
        <Alert tone="danger">{errorText(complaints.error)}</Alert>
      ) : complaints.data.complaints.length === 0 ? (
        <p className="text-secondary">
          {all ? 'No rights complaint yet.' : 'No rights complaint is open.'}
        </p>
      ) : (
        complaints.data.complaints.map((complaint) => (
          <Card key={complaint.id} className="flex flex-col gap-2">
            <Complaint complaint={complaint} />
            {complaint.status === 'open' ? (
              <DecisionForm
                label="Why, as the store's owner or the complainant is told"
                name="note"
                actions={[
                  {
                    label: 'Uphold: take the listings down',
                    path: `/rights/${complaint.id}/uphold`,
                    refresh: [['rights']],
                    done: 'Upheld: the listings are held off sale and the owner is told.',
                  },
                  {
                    label: 'Dismiss',
                    path: `/rights/${complaint.id}/dismiss`,
                    refresh: [['rights']],
                    done: `Dismissed: write to ${complaint.complainant} at ${complaint.email} with why.`,
                    variant: 'secondary',
                  },
                ]}
              />
            ) : (
              complaint.decision && <p>{complaint.decision}</p>
            )}
          </Card>
        ))
      )}
      <h2 className="text-xl font-semibold">Owners&rsquo; answers</h2>
      {answers.isPending ? (
        <p>Loading…</p>
      ) : answers.isError ? (
        <Alert tone="danger">{errorText(answers.error)}</Alert>
      ) : answers.data.complaints.length === 0 ? (
        <p className="text-secondary">No answer is waiting.</p>
      ) : (
        answers.data.complaints.map((complaint) => (
          <Card key={complaint.id} className="flex flex-col gap-2">
            <Complaint complaint={complaint} />
            <section className="flex flex-col gap-1 rounded-card border border-line p-3">
              <h3 className="font-semibold">
                Its owner answers, sworn as {complaint.counter?.signature}
              </h3>
              <p className="whitespace-pre-wrap">{complaint.counter?.words}</p>
            </section>
            <DecisionForm
              label="Why, as the store's owner is told"
              name="answer"
              actions={[
                {
                  label: 'Refuse the answer',
                  path: `/rights/${complaint.id}/refuse-answer`,
                  refresh: [['rights-answers']],
                  done: 'Refused: the listings stay held, and the owner is told.',
                  variant: 'secondary',
                },
              ]}
            />
            <DecisionForm
              label="Why the listings go back on sale, as the owner is told"
              name="note"
              actions={[
                {
                  label: 'Let the listings go',
                  path: `/rights/${complaint.id}/release`,
                  refresh: [['rights-answers'], ['rights']],
                  done: `Let go: the owner is told, and ${complaint.complainant} may be written to.`,
                },
              ]}
            />
          </Card>
        ))
      )}
      <ClearListing />
    </div>
  );
}
