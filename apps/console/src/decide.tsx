import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { ConsoleError, consoleCall, errorText } from './api';
import { Alert, Button } from './ui';

/** Why shoppers report stores, and why stores are taken down, in Hatti's people's words. */
export const REASONS: Record<string, string> = {
  never_delivered: 'Never delivered',
  not_as_described: 'Not as described',
  counterfeit: 'Counterfeit',
  prohibited: 'Prohibited goods',
  scam: 'Scam',
  impersonation: 'Impersonation',
  other: 'Something else',
};

/** A call that changes something, its queues read again once it is done. */
export function useDecision<T>(path: string, refresh: readonly string[][]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => consoleCall<T>(path, { method: 'POST', body }),
    onSuccess: () => {
      for (const key of [...refresh, ['actions']]) void client.invalidateQueries({ queryKey: key });
    },
  });
}

/** What went wrong, under the field it is about where the server says. */
export const problemOf = (error: unknown) =>
  error instanceof ConsoleError ? error.message : error ? errorText(error) : null;

/**
 * Words to decide with, and the buttons that decide: each sends `{ [name]: words, ...extra }` to
 * its own address. Said once it is done.
 */
export function DecisionForm({
  label,
  name,
  actions,
  required = true,
}: {
  label: string;
  name: string;
  required?: boolean;
  actions: {
    label: string;
    path: string;
    extra?: Record<string, unknown>;
    refresh: readonly string[][];
    done: string;
    variant?: 'primary' | 'secondary';
  }[];
}) {
  const id = useId();
  const [words, setWords] = useState('');
  const [said, setSaid] = useState<ReactNode>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const client = useQueryClient();
  const send = async (action: (typeof actions)[number]) => {
    setProblem(null);
    setSaid(null);
    if (required && !words.trim()) return setProblem(`${label}: say it first`);
    setBusy(action.label);
    try {
      await consoleCall(action.path, {
        method: 'POST',
        body: { [name]: words, ...action.extra },
      });
      setSaid(action.done);
      setWords('');
      for (const key of [...action.refresh, ['actions']]) {
        void client.invalidateQueries({ queryKey: key });
      }
    } catch (failure) {
      setProblem(problemOf(failure));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={2}
        value={words}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => setWords(event.target.value)}
        className="rounded-control border border-line bg-surface p-2"
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      {said && <Alert tone="success">{said}</Alert>}
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.label}
            variant={action.variant ?? 'primary'}
            busy={busy === action.label}
            disabled={busy !== null}
            onClick={() => void send(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** A list's toggle between what waits and everything. */
export function ShowAll({ all, onChange }: { all: boolean; onChange: (all: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked)} />
      Show decided ones too
    </label>
  );
}
