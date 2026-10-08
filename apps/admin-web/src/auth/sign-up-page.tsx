import { parsePkMobile } from '@hatti/pk';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, authRequest, browserFetch } from '../api/client';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { AuthLayout } from './auth-layout';
import { useSessionStore } from './context';
import type { Tokens } from './session';

/** The field an error belongs to, from the API's `fields`: "email", "password"… */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(error.fields.map((field) => [field.field.at(-1) ?? '', field.message]));
}

/**
 * Opening an account with an email and password (ONB-01), for merchants who would rather not sign
 * in by their mobile; a number may be added, and proved later.
 */
export function SignUpPage() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const mobile = phone.trim() ? parsePkMobile(phone) : null;
    if (phone.trim() && !mobile) {
      setFields({ phone: t('signIn.invalidPhone') });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const tokens = await authRequest<Tokens>(browserFetch, '/auth/sign-up', {
        body: {
          name: name.trim(),
          email: email.trim(),
          password,
          language: locale,
          ...(mobile ? { phone: mobile.e164 } : {}),
        },
      });
      store.signedIn(tokens);
      await navigate({ to: '/shops' });
    } catch (failure) {
      const byField = fieldErrors(failure);
      setFields(byField);
      if (Object.keys(byField).length === 0) setError(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('signUp.title')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <TextField
          label={t('signUp.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          error={fields.name}
          required
        />
        <TextField
          label={t('signUp.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          error={fields.email}
          required
          ltr
        />
        <TextField
          label={t('signUp.password')}
          hint={t('signUp.passwordHint')}
          type="password"
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          error={fields.password}
          required
          ltr
        />
        <TextField
          label={t('signUp.phoneOptional')}
          type="tel"
          inputMode="tel"
          placeholder="0300 1234567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          error={fields.phone}
          ltr
        />
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" busy={busy}>
          {t('signUp.submit')}
        </Button>
        <Link to="/sign-in" className="text-primary underline-offset-4 hover:underline">
          {t('signUp.haveAccount')}
        </Link>
      </form>
    </AuthLayout>
  );
}
