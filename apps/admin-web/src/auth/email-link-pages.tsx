import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { authRequest, browserFetch } from '../api/client';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { tokenOf } from '../invitation/invitation-page';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { AuthLayout } from './auth-layout';
import { ME_KEY, useSession, useSessionStore } from './context';
import { fieldErrors } from './sign-up-page';

const linkClass = 'text-primary underline-offset-4 hover:underline';

/** The token of the link that opened the page, after its `#`, read once. */
function useLinkToken(): string | null {
  const [token] = useState(() => tokenOf(window.location.hash));
  return token;
}

/**
 * Asking for a link to set a new password (ONB-01, ADR-165). The core answers the same whether or
 * not an account has the email, so the page does too.
 */
export function ForgotPasswordPage() {
  const { t, locale } = useLocale();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await authRequest(browserFetch, '/auth/password/forgot', {
        body: { email: email.trim(), language: locale },
      });
      setSent(email.trim());
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('forgot.title')}>
      {sent ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">{t('forgot.sent', { email: sent })}</Alert>
          <Link to="/sign-in" className={linkClass}>
            {t('link.backToSignIn')}
          </Link>
        </div>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
          <p className="text-secondary">{t('forgot.body')}</p>
          <TextField
            label={t('signIn.email')}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
            required
            ltr
          />
          {problem && <Alert tone="danger">{problem}</Alert>}
          <Button type="submit" busy={busy}>
            {t('forgot.submit')}
          </Button>
          <Link to="/sign-in" className={linkClass}>
            {t('link.backToSignIn')}
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}

/**
 * The page a reset link opens (`/reset-password#token=…`): a new password, which signs out every
 * session the account had, this tab's too; then signing in with it.
 */
export function ResetPasswordPage() {
  const { t } = useLocale();
  const token = useLinkToken();
  const store = useSessionStore();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(token ? null : t('link.noToken'));
  const [fields, setFields] = useState<Record<string, string>>({});

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      await authRequest(browserFetch, '/auth/password/reset', { body: { token, password } });
      // The core signed out every session of the account; this tab forgets its own.
      await store.signOut();
      setDone(true);
    } catch (failure) {
      const byField = fieldErrors(failure);
      setFields(byField);
      if (Object.keys(byField).length === 0) setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('reset.title')}>
      {done ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">{t('reset.done')}</Alert>
          <Link to="/sign-in" className={linkClass}>
            {t('signIn.submit')}
          </Link>
        </div>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
          {token && (
            <TextField
              label={t('reset.password')}
              hint={t('signUp.passwordHint')}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              error={fields.password}
              autoFocus
              required
              ltr
            />
          )}
          {problem && <Alert tone="danger">{problem}</Alert>}
          {token && (
            <Button type="submit" busy={busy}>
              {t('reset.submit')}
            </Button>
          )}
          <Link to="/forgot-password" className={linkClass}>
            {t('reset.another')}
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}

/**
 * A page an email's link opens to prove an address: confirmed with a tap rather than as it opens,
 * so a mail scanner opening the link, or the page drawn twice, spends nothing.
 */
function EmailLinkPage({
  path,
  title,
  body,
  submit,
  done,
}: {
  path: '/auth/email/verify' | '/auth/email/change/confirm';
  title: MessageKey;
  body: MessageKey;
  submit: MessageKey;
  done: MessageKey;
}) {
  const { t } = useLocale();
  const token = useLinkToken();
  const { signedIn } = useSession();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(token ? null : t('link.noToken'));

  const onConfirm = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { user } = await authRequest<{ user: { email: string | null } }>(browserFetch, path, {
        body: { token },
      });
      if (signedIn) await queryClient.invalidateQueries({ queryKey: ME_KEY });
      setEmail(user.email ?? '');
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t(title)}>
      <div className="flex flex-col gap-4">
        {email !== null ? (
          <Alert tone="success">{t(done, { email })}</Alert>
        ) : (
          token && (
            <>
              <p className="text-secondary">{t(body)}</p>
              <Button busy={busy} onClick={() => void onConfirm()}>
                {t(submit)}
              </Button>
            </>
          )
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        <Link to="/" className={linkClass}>
          {t('link.openHatti')}
        </Link>
      </div>
    </AuthLayout>
  );
}

/** The page a new account's link opens (`/verify-email#token=…`), proving its email. */
export function VerifyEmailPage() {
  return (
    <EmailLinkPage
      path="/auth/email/verify"
      title="verify.title"
      body="verify.body"
      submit="verify.submit"
      done="verify.done"
    />
  );
}

/**
 * The page a change of email's link opens (`/change-email#token=…`), sent to the new address: the
 * account's email becomes it, and the old one is told.
 */
export function ChangeEmailPage() {
  return (
    <EmailLinkPage
      path="/auth/email/change/confirm"
      title="change.title"
      body="change.body"
      submit="change.submit"
      done="change.done"
    />
  );
}
