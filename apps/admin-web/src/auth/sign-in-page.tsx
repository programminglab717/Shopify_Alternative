import { parsePkMobile } from '@hatti/pk';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { authRequest, browserFetch } from '../api/client';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { AuthLayout } from './auth-layout';
import { useSessionStore } from './context';
import type { Tokens } from './session';

/** What `/auth/sign-in`, `/auth/phone/sign-in` and `/auth/sign-in/verify` answer. */
type SignInAnswer =
  | ({ status: 'signed_in' } & Tokens)
  | { status: 'mfa_required'; challengeToken: string; methods: string[] }
  | { status: 'sign_up_required'; signUpToken: string; phone: string };

type Step =
  | { kind: 'phone' }
  | { kind: 'code'; phone: string; shown: string; resendAt: number }
  | { kind: 'email' }
  | { kind: 'mfa'; challengeToken: string }
  | { kind: 'name'; signUpToken: string };

/** Seconds until `at`, counting down while the screen is open. */
function useSecondsUntil(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null || at <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [at]);
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Signing in (docs/design/03 F1): by a code sent to the merchant's mobile on WhatsApp, or SMS
 * (ADR-159), or by email and password; then the second factor where the account has one, and a
 * name for a number new to Hatti, which opens its account.
 */
export function SignInPage() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const resendIn = useSecondsUntil(step.kind === 'code' ? step.resendAt : null);

  const go = (next: Step) => {
    setError(null);
    setCode('');
    setStep(next);
  };

  /** Runs `call`, showing what went wrong in the merchant's words. */
  const run = async (call: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (failure) {
      setError(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const answered = async (answer: SignInAnswer) => {
    if (answer.status === 'signed_in') {
      store.signedIn(answer);
      await navigate({ to: '/' });
    } else if (answer.status === 'mfa_required') {
      go({ kind: 'mfa', challengeToken: answer.challengeToken });
    } else {
      go({ kind: 'name', signUpToken: answer.signUpToken });
    }
  };

  const sendCode = (e164: string, channel: 'whatsapp' | 'sms') =>
    run(async () => {
      const sent = await authRequest<{ phone: string; resendAfter: string }>(
        browserFetch,
        '/auth/phone/code',
        { body: { phone: e164, channel, language: locale } },
      );
      go({ kind: 'code', phone: e164, shown: sent.phone, resendAt: Date.parse(sent.resendAfter) });
    });

  const onPhone = (event: FormEvent) => {
    event.preventDefault();
    const mobile = parsePkMobile(phone);
    if (!mobile) {
      setError(t('signIn.invalidPhone'));
      return;
    }
    void sendCode(mobile.e164, 'whatsapp');
  };

  const onCode = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'code') return;
    void run(async () =>
      answered(
        await authRequest<SignInAnswer>(browserFetch, '/auth/phone/sign-in', {
          body: { phone: step.phone, code: code.trim() },
        }),
      ),
    );
  };

  const onEmail = (event: FormEvent) => {
    event.preventDefault();
    void run(async () =>
      answered(
        await authRequest<SignInAnswer>(browserFetch, '/auth/sign-in', {
          body: { email: email.trim(), password },
        }),
      ),
    );
  };

  const onMfa = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'mfa') return;
    void run(async () =>
      answered(
        await authRequest<SignInAnswer>(browserFetch, '/auth/sign-in/verify', {
          body: { challengeToken: step.challengeToken, code: code.trim() },
        }),
      ),
    );
  };

  const onName = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'name') return;
    void run(async () => {
      const tokens = await authRequest<Tokens>(browserFetch, '/auth/phone/sign-up', {
        body: {
          signUpToken: step.signUpToken,
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          language: locale,
        },
      });
      store.signedIn(tokens);
      await navigate({ to: '/shops' });
    });
  };

  const tabs = (
    <div role="tablist" className="grid grid-cols-2 gap-1 rounded-control border border-line p-1">
      {(['phone', 'email'] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={step.kind === kind}
          onClick={() => go({ kind })}
          className={`min-h-10 rounded-control ${
            step.kind === kind ? 'bg-primary text-on-primary' : 'text-secondary'
          }`}
        >
          {t(kind === 'phone' ? 'signIn.byPhone' : 'signIn.byEmail')}
        </button>
      ))}
    </div>
  );

  const alert = error && <Alert tone="danger">{error}</Alert>;

  if (step.kind === 'mfa') {
    return (
      <AuthLayout title={t('signIn.mfaTitle')}>
        <form onSubmit={onMfa} className="flex flex-col gap-4">
          <p className="text-secondary">{t('signIn.mfaBody')}</p>
          <TextField
            label={t('signIn.mfaCode')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
            required
            ltr
          />
          {alert}
          <Button type="submit" busy={busy}>
            {t('action.continue')}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  if (step.kind === 'name') {
    return (
      <AuthLayout title={t('signIn.nameTitle')}>
        <form onSubmit={onName} className="flex flex-col gap-4">
          <p className="text-secondary">{t('signIn.nameBody')}</p>
          <TextField
            label={t('signIn.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            autoFocus
            required
          />
          <TextField
            label={t('signIn.emailOptional')}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            ltr
          />
          {alert}
          <Button type="submit" busy={busy}>
            {t('signIn.createAccount')}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('signIn.title')}>
      <div className="flex flex-col gap-4">
        {tabs}
        {step.kind === 'phone' && (
          <form onSubmit={onPhone} className="flex flex-col gap-4">
            <TextField
              label={t('signIn.phone')}
              hint={t('signIn.phoneHint')}
              type="tel"
              inputMode="tel"
              placeholder="0300 1234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              required
              ltr
            />
            {alert}
            <Button type="submit" busy={busy}>
              {t('signIn.sendCode')}
            </Button>
          </form>
        )}
        {step.kind === 'code' && (
          <form onSubmit={onCode} className="flex flex-col gap-4">
            <p className="text-secondary">{t('signIn.codeSent', { phone: step.shown })}</p>
            <TextField
              label={t('signIn.code')}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
              required
              ltr
            />
            {alert}
            <Button type="submit" busy={busy}>
              {t('signIn.submit')}
            </Button>
            {resendIn > 0 ? (
              <p className="text-secondary">{t('signIn.resendIn', { seconds: resendIn })}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="tertiary" onClick={() => void sendCode(step.phone, 'whatsapp')}>
                  {t('signIn.resend')}
                </Button>
                <Button variant="tertiary" onClick={() => void sendCode(step.phone, 'sms')}>
                  {t('signIn.bySms')}
                </Button>
              </div>
            )}
          </form>
        )}
        {step.kind === 'email' && (
          <form onSubmit={onEmail} className="flex flex-col gap-4">
            <TextField
              label={t('signIn.email')}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              ltr
            />
            <TextField
              label={t('signIn.password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              ltr
            />
            {alert}
            <Button type="submit" busy={busy}>
              {t('signIn.submit')}
            </Button>
          </form>
        )}
        <Link to="/sign-up" className="text-primary underline-offset-4 hover:underline">
          {t('signIn.newAccount')}
        </Link>
      </div>
    </AuthLayout>
  );
}
