import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { consoleCall, errorText } from './api';
import { DecisionForm, ShowAll, problemOf, useDecision } from './decide';
import type { Verification } from './types';
import { Alert, Button, Card, when } from './ui';

/** Links to a waiting verification's photos, asked for (and logged) only when looked at. */
function Documents({ verification }: { verification: Verification }) {
  const [links, setLinks] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    try {
      setLinks(
        (await consoleCall<{ links: string[] }>(`/verifications/${verification.id}/documents`))
          .links,
      );
    } catch (failure) {
      setProblem(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  if (links) {
    return (
      <ul className="flex flex-wrap gap-3">
        {links.map((link, index) => (
          <li key={link}>
            <a href={link} target="_blank" rel="noreferrer noopener" className="underline">
              Document {index + 1}
            </a>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button variant="secondary" className="self-start" busy={busy} onClick={() => void show()}>
        Show its {verification.documents} document{verification.documents === 1 ? '' : 's'}
      </Button>
    </div>
  );
}

/** Takes a shop's verification back, by its handle: a business's with its owner's. */
function TakeBack() {
  const id = useId();
  const [handle, setHandle] = useState('');
  const [level, setLevel] = useState<'identity' | 'business'>('identity');
  const [answer, setAnswer] = useState('');
  const takeBack = useDecision<{ verifications: Verification[] }>(
    `/shops/${encodeURIComponent(handle.trim())}/unverify`,
    [['verifications']],
  );
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Take a verification back</h2>
      <label htmlFor={`${id}-shop`} className="font-medium">
        Store&rsquo;s handle
      </label>
      <input
        id={`${id}-shop`}
        value={handle}
        onChange={(event) => setHandle(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      <label htmlFor={`${id}-level`} className="font-medium">
        Which
      </label>
      <select
        id={`${id}-level`}
        value={level}
        onChange={(event) => setLevel(event.target.value as 'identity' | 'business')}
        className="rounded-control border border-line bg-surface p-2"
      >
        <option value="identity">The owner (and the business with it)</option>
        <option value="business">The business</option>
      </select>
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
      {takeBack.isError && <Alert tone="danger">{problemOf(takeBack.error)}</Alert>}
      {takeBack.isSuccess && <Alert tone="success">Taken back; the shop is told.</Alert>}
      <Button
        variant="secondary"
        className="self-start"
        busy={takeBack.isPending}
        disabled={!handle.trim()}
        onClick={() => takeBack.mutate({ level, answer })}
      >
        Take it back
      </Button>
    </Card>
  );
}

/** Shops' verifications (ADR-465): their owners' CNICs, then their businesses' NTNs. */
export function VerificationsPage() {
  const [all, setAll] = useState(false);
  const verifications = useQuery({
    queryKey: ['verifications', all],
    queryFn: () =>
      consoleCall<{ verifications: Verification[] }>(`/verifications${all ? '?all=1' : ''}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Verifications</h1>
        <ShowAll all={all} onChange={setAll} />
      </div>
      {verifications.isPending ? (
        <p>Loading…</p>
      ) : verifications.isError ? (
        <Alert tone="danger">{errorText(verifications.error)}</Alert>
      ) : verifications.data.verifications.length === 0 ? (
        <p className="text-secondary">
          {all ? 'No verification asked for yet.' : 'No verification is waiting.'}
        </p>
      ) : (
        verifications.data.verifications.map((each) => (
          <Card key={each.id} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">
              {each.shop.name} <span className="text-secondary">({each.shop.handle})</span>
            </h2>
            <p>
              {each.level === 'identity' ? 'The owner' : 'The business'}: {each.name} ·{' '}
              {each.level === 'identity'
                ? `CNIC ${each.cnic ?? `…${each.cnicLast4 ?? ''}`}`
                : `NTN ${each.ntn ?? ''}`}
            </p>
            <p className="text-secondary">
              Asked {when(each.createdAt)}
              {each.status !== 'waiting' &&
                ` · ${each.status} by ${each.decidedBy ?? '?'}${each.answer ? `: ${each.answer}` : ''}`}
            </p>
            {each.status === 'waiting' && (
              <>
                {each.documents > 0 && <Documents verification={each} />}
                <DecisionForm
                  label="A note, or why it is refused (the shop reads it)"
                  name="answer"
                  required={false}
                  actions={[
                    {
                      label: 'Verify',
                      path: `/verifications/${each.id}/approve`,
                      refresh: [['verifications']],
                      done: 'Verified; its documents are deleted and the shop is told.',
                    },
                    {
                      label: 'Refuse',
                      path: `/verifications/${each.id}/refuse`,
                      refresh: [['verifications']],
                      done: 'Refused; its documents are deleted and the shop is told.',
                      variant: 'secondary',
                    },
                  ]}
                />
              </>
            )}
          </Card>
        ))
      )}
      <TakeBack />
    </div>
  );
}
