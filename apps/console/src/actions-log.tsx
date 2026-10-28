import { useQuery } from '@tanstack/react-query';
import { consoleCall, errorText } from './api';
import type { ConsoleAction } from './types';
import { Alert, when } from './ui';

/** What was done in the console, by whom, the latest first: written before each was done. */
export function ActionsLogPage() {
  const actions = useQuery({
    queryKey: ['actions'],
    queryFn: () => consoleCall<{ actions: ConsoleAction[] }>('/actions?first=100'),
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Log</h1>
      <p className="text-secondary">
        Everything done here, by whom, written down before it was done. It can&rsquo;t be changed.
      </p>
      {actions.isPending ? (
        <p>Loading…</p>
      ) : actions.isError ? (
        <Alert tone="danger">{errorText(actions.error)}</Alert>
      ) : actions.data.actions.length === 0 ? (
        <p className="text-secondary">Nothing done yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
          {actions.data.actions.map((each) => (
            <li key={each.id} className="flex flex-col p-3">
              <span className="font-medium">
                {each.action} {each.subject && <code>{each.subject}</code>}
              </span>
              <span className="text-secondary">
                {each.email} · {when(each.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
