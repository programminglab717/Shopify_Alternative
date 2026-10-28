import { useNavigate } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { authRequest, browserFetch } from '../api/client';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { AuthLayout } from './auth-layout';
import { useSessionStore } from './context';
import type { Tokens } from './session';

// Signing in through a shop's organisation (ADM-09, ADR-864): the core sends the browser to the
// organisation's identity provider, which sends it back to /sso/callback with a code the admin
// trades for the session. The state the core gave is kept in this tab, so an answer the admin
// didn't ask for, as one an attacker started, is never taken.

const STATE_KEY = 'hatti.sso.state';

/** Starts a sign-in through the organisation whose domain the email typed is of. */
export function SsoSignIn() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const started = await authRequest<{ url: string; state: string }>(
        browserFetch,
        '/auth/sso/start',
        { body: { email: email.trim() } },
      );
      try {
        window.sessionStorage.setItem(STATE_KEY, started.state);
      } catch {
        // A tab that keeps nothing can't take the answer back; the provider is still tried.
      }
      window.location.assign(started.url);
    } catch (failure) {
      setProblem(errorText(failure, t));
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        variant="secondary"
        icon={<Building2 aria-hidden className="size-5" />}
        onClick={() => setOpen(true)}
      >
        {t('sso.signIn')}
      </Button>
    );
  }
  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <TextField
        label={t('sso.workEmail')}
        hint={t('sso.workEmailHint')}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="username"
        required
        ltr
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button type="submit" busy={busy}>
        {t('sso.continue')}
      </Button>
    </form>
  );
}

/** Where the provider's answer comes back: traded for the session, or why not. */
export function SsoCallbackPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const store = useSessionStore();
  const [problem, setProblem] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    const code = params.get('code');
    let kept: string | null;
    try {
      kept = window.sessionStorage.getItem(STATE_KEY);
      window.sessionStorage.removeItem(STATE_KEY);
    } catch {
      kept = null;
    }
    if (error || !code) {
      setProblem(t(`sso.error.${error ?? 'expired'}` as MessageKey));
      return;
    }
    if (!kept || kept !== params.get('state')) {
      setProblem(t('sso.error.notStarted'));
      return;
    }
    void (async () => {
      try {
        const answer = await authRequest<Tokens & { status: string }>(
          browserFetch,
          '/auth/sso/redeem',
          { body: { code } },
        );
        store.signedIn(answer);
        await navigate({ to: '/', replace: true });
      } catch (failure) {
        setProblem(errorText(failure, t));
      }
    })();
  }, [navigate, store, t]);

  return (
    <AuthLayout title={t('sso.title')}>
      {problem ? (
        <div className="flex flex-col gap-4">
          <Alert tone="danger">{problem}</Alert>
          <Button onClick={() => void navigate({ to: '/sign-in' })}>{t('sso.back')}</Button>
        </div>
      ) : (
        <Loading label={t('sso.signingIn')} />
      )}
    </AuthLayout>
  );
}
