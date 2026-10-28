import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ConsoleError, consoleCall, errorText } from './api';
import { keepSession, keepSignInState, signInStateOf, type ConsoleSession } from './session';
import { Alert, Button, Card } from './ui';

/** Why a sign-in through Hatti's provider did not happen, as the console's server says it. */
export const SIGN_IN_PROBLEMS: Record<string, string> = {
  unavailable: "Hatti's sign-in isn't set up for the console.",
  unreachable: "Hatti's sign-in can't be reached now. Try again in a minute.",
  expired: 'That sign-in expired. Start it again.',
  refused: 'The sign-in was refused or cancelled.',
  invalid: "The sign-in's answer couldn't be trusted. Start it again.",
  not_agent: "That account isn't one of Hatti's support agents.",
  no_key: 'Sign in with your security key.',
  other_tab: "That sign-in wasn't started in this tab. Start it again here.",
  ended: 'Your session ended. Sign in again.',
};

/** Signing in: through Hatti's own provider, with a security key, and back. */
export function SignInPage() {
  const search = useSearch({ from: '/sign-in' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = error ?? (search.error ? (SIGN_IN_PROBLEMS[search.error] ?? null) : null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await consoleCall<{ url: string; state: string }>('/auth/start', {
        method: 'POST',
        body: {},
      });
      keepSignInState(started.state);
      window.location.assign(started.url);
    } catch (failure) {
      setBusy(false);
      setError(errorText(failure));
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-4">
      <h1 className="text-2xl font-semibold">Hatti console</h1>
      <Card className="flex flex-col gap-3">
        <p>For Hatti&rsquo;s own people. Sign in with your Hatti account and its security key.</p>
        {shown && <Alert tone="danger">{shown}</Alert>}
        <Button busy={busy} onClick={() => void start()}>
          Sign in with Hatti
        </Button>
      </Card>
    </main>
  );
}

/** Where the provider's answer comes back: traded for the session, if this tab began it. */
export function SignedInPage() {
  const search = useSearch({ from: '/signed-in' });
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const kept = signInStateOf();
    keepSignInState(null);
    const back = (problem: string) =>
      void navigate({ to: '/sign-in', search: { error: problem }, replace: true });
    if (search.error) return back(search.error);
    if (!search.code || !kept || kept !== search.state) return back('other_tab');
    consoleCall<ConsoleSession>('/auth/redeem', { method: 'POST', body: { code: search.code } })
      .then((session) => {
        keepSession(session);
        void navigate({ to: '/support', replace: true });
      })
      .catch((failure: unknown) =>
        failure instanceof ConsoleError && failure.code === 'CONSOLE_EXPIRED'
          ? back('expired')
          : setError(errorText(failure)),
      );
  }, [navigate, search.code, search.error, search.state]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-4">
      {error ? <Alert tone="danger">{error}</Alert> : <p>Signing you in…</p>}
    </main>
  );
}
