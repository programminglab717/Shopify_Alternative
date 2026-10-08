import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api/client';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { AuthLayout } from './auth-layout';
import { ME_KEY, useSessionStore } from './context';

/** "JBSWY3DPEHPK3PXP" as "JBSW Y3DP EHPK 3PXP", easier to type into an app. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

type Setup =
  | { kind: 'starting' }
  | { kind: 'scan'; secret: string; uri: string }
  | { kind: 'recovery'; codes: string[] }
  | { kind: 'signInAgain' }
  | { kind: 'failed'; message: string };

/**
 * Turning on the second step (ADR-020): owners, managers and accountants must before the Admin
 * API lets them in. An authenticator app's key, its code to confirm it, and recovery codes to keep.
 */
export function TwoStepPage() {
  const { t } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { shop } = useSearch({ from: '/two-step' });
  const [setup, setSetup] = useState<Setup>({ kind: 'starting' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    store
      .auth<{ secret: string; otpauthUri: string }>('/auth/two-step/totp/setup', {
        method: 'POST',
      })
      .then((answer) => setSetup({ kind: 'scan', secret: answer.secret, uri: answer.otpauthUri }))
      .catch((failure: unknown) =>
        setSetup(
          failure instanceof ApiError && failure.code === 'REAUTHENTICATION_REQUIRED'
            ? { kind: 'signInAgain' }
            : { kind: 'failed', message: errorText(failure, t) },
        ),
      );
  }, [store, t]);

  const onConfirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const answer = await store.auth<{ recoveryCodes: string[] }>('/auth/two-step/totp/confirm', {
        body: { code: code.trim() },
      });
      store.mfaProved();
      setSetup({ kind: 'recovery', codes: answer.recoveryCodes });
    } catch (failure) {
      setError(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const onSaved = async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
    await navigate(shop ? { to: '/$shopId', params: { shopId: shop } } : { to: '/shops' });
  };

  const signInAgain = async () => {
    await store.signOut();
    await navigate({ to: '/sign-in' });
  };

  return (
    <AuthLayout title={setup.kind === 'recovery' ? t('twoStep.recoveryTitle') : t('twoStep.title')}>
      {setup.kind === 'starting' && <Loading label={t('state.loading')} />}
      {setup.kind === 'failed' && <Alert tone="danger">{setup.message}</Alert>}
      {setup.kind === 'signInAgain' && (
        <div className="flex flex-col gap-4">
          <Alert tone="warning">{t('twoStep.signInAgain')}</Alert>
          <Button onClick={() => void signInAgain()}>{t('signIn.submit')}</Button>
        </div>
      )}
      {setup.kind === 'scan' && (
        <form onSubmit={(event) => void onConfirm(event)} className="flex flex-col gap-4">
          <p className="text-secondary">{t('twoStep.body')}</p>
          <p>{t('twoStep.step1')}</p>
          <code
            dir="ltr"
            className="num rounded-control border border-line bg-canvas p-3 text-center text-lg tracking-wider select-all"
          >
            {grouped(setup.secret)}
          </code>
          <a href={setup.uri} className="text-primary underline-offset-4 hover:underline">
            {t('twoStep.openApp')}
          </a>
          <p>{t('twoStep.step2')}</p>
          <TextField
            label={t('twoStep.code')}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            required
            ltr
          />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" busy={busy}>
            {t('twoStep.confirm')}
          </Button>
        </form>
      )}
      {setup.kind === 'recovery' && (
        <div className="flex flex-col gap-4">
          <p className="text-secondary">{t('twoStep.recoveryBody')}</p>
          <ul dir="ltr" className="num grid grid-cols-2 gap-2 rounded-control bg-canvas p-3">
            {setup.codes.map((recovery) => (
              <li key={recovery} className="select-all">
                {recovery}
              </li>
            ))}
          </ul>
          <Button onClick={() => void onSaved()}>{t('twoStep.saved')}</Button>
        </div>
      )}
    </AuthLayout>
  );
}
