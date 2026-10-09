import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleDashed,
  KeyRound,
  LogOut,
  MonitorSmartphone,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ME_KEY, useMe, useSessionStore } from '../auth/context';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { GoogleButton } from '../auth/google';
import type { GoogleOptions } from '../auth/google';
import { errorText } from '../i18n/errors';
import { formatDateTime, formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { FormSection } from '../products/product-form';
import { useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { createPasskey, passkeysWork } from './webauthn';

interface SessionInfo {
  id: string;
  current: boolean;
  device: string;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
}

interface PasskeyInfo {
  id: string;
  name: string;
  multiDevice: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const SESSIONS_KEY = ['account', 'sessions'] as const;
const PASSKEYS_KEY = ['account', 'passkeys'] as const;

/** A change to the account, run once, its problem said where it was made. */
function useChange() {
  const { t } = useLocale();
  const client = useQueryClient();
  const recent = useRecentAuthentication();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    setDone(null);
    await recent.run(
      async () => {
        const said = await action();
        await client.invalidateQueries({ queryKey: ME_KEY });
        await client.invalidateQueries({ queryKey: ['account'] });
        setDone(said);
      },
      (failure) => setProblem(errorText(failure, t)),
    );
    setBusy(false);
  };
  const said = (
    <>
      {recent.panel}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done && <Alert tone="success">{done}</Alert>}
    </>
  );
  return { run, busy, said };
}

function Proved({ proved }: { proved: boolean }) {
  const { t } = useLocale();
  return (
    <Badge
      colour={proved ? 'delivered' : 'needsConfirmation'}
      icon={proved ? CircleCheck : CircleDashed}
      label={t(proved ? 'account.proved' : 'account.notProved')}
    />
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-secondary">{label}</span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

/** The account's email: proved by a link, or changed to another once its link is opened. */
function Email({ email, proved }: { email: string | null; proved: boolean }) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const change = useChange();
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState('');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await change.run(async () => {
      const sent = await store.auth<{ email: string }>('/auth/email/change', {
        method: 'POST',
        body: { email: next.trim(), language: locale },
      });
      setEditing(false);
      return t('account.emailSent', { email: sent.email });
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Row label={t('account.email')}>
        {email ? (
          <>
            <span dir="ltr">{email}</span>
            <Proved proved={proved} />
          </>
        ) : (
          <span className="text-secondary">{t('account.none')}</span>
        )}
      </Row>
      {!editing && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {t(email ? 'account.emailChange' : 'account.emailAdd')}
          </Button>
          {email && !proved && (
            <Button
              variant="tertiary"
              busy={change.busy}
              onClick={() =>
                void change.run(async () => {
                  await store.auth('/auth/email/verification', {
                    method: 'POST',
                    body: { language: locale },
                  });
                  return t('account.emailSent', { email });
                })
              }
            >
              {t('account.emailProve')}
            </Button>
          )}
        </div>
      )}
      {editing && (
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('account.emailNew')}
            type="email"
            ltr
            required
            className="w-64"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Button type="submit" busy={change.busy} disabled={next.trim() === ''}>
            {t('account.emailSend')}
          </Button>
          <Button variant="tertiary" onClick={() => setEditing(false)}>
            {t('returns.cancel')}
          </Button>
        </form>
      )}
      {change.said}
    </div>
  );
}

/** The account's mobile number: proved by a code to it, which signs the account in, or taken off. */
function Phone({ phone, proved }: { phone: string | null; proved: boolean }) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const change = useChange();
  const [step, setStep] = useState<'idle' | 'number' | 'code'>('idle');
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [asking, setAsking] = useState(false);

  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    await change.run(async () => {
      const sent = await store.auth<{ phone: string }>('/auth/phone/code', {
        method: 'POST',
        body: { phone: number.trim(), channel: 'whatsapp', language: locale },
      });
      setStep('code');
      return t('account.codeSent', { phone: formatPhone(sent.phone) });
    });
  };
  const prove = async (event: FormEvent) => {
    event.preventDefault();
    await change.run(async () => {
      await store.auth('/auth/phone', {
        method: 'POST',
        body: { phone: number.trim(), code: code.trim(), language: locale },
      });
      setStep('idle');
      setCode('');
      return t('account.phoneSaved');
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Row label={t('account.phone')}>
        {phone ? (
          <>
            <span className="num" dir="ltr">
              {formatPhone(phone)}
            </span>
            <Proved proved={proved} />
          </>
        ) : (
          <span className="text-secondary">{t('account.none')}</span>
        )}
      </Row>
      {step === 'idle' && !asking && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setStep('number')}>
            {t(phone ? 'account.phoneChange' : 'account.phoneAdd')}
          </Button>
          {phone && (
            <Button variant="danger" onClick={() => setAsking(true)}>
              {t('account.phoneRemove')}
            </Button>
          )}
        </div>
      )}
      {asking && (
        <div className="flex flex-col gap-2 rounded-card border border-line p-3">
          <p>{t('account.phoneRemoveAsk')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={change.busy}
              onClick={() =>
                void change.run(async () => {
                  await store.auth('/auth/phone', { method: 'DELETE' });
                  setAsking(false);
                  return t('account.phoneRemoved');
                })
              }
            >
              {t('account.phoneRemoveConfirm')}
            </Button>
            <Button variant="tertiary" onClick={() => setAsking(false)}>
              {t('returns.cancel')}
            </Button>
          </div>
        </div>
      )}
      {step === 'number' && (
        <form onSubmit={(event) => void sendCode(event)} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('account.phoneNew')}
            type="tel"
            inputMode="tel"
            placeholder="0300 1234567"
            ltr
            required
            className="w-48"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
          <Button type="submit" busy={change.busy} disabled={number.trim() === ''}>
            {t('account.codeSend')}
          </Button>
          <Button variant="tertiary" onClick={() => setStep('idle')}>
            {t('returns.cancel')}
          </Button>
        </form>
      )}
      {step === 'code' && (
        <form onSubmit={(event) => void prove(event)} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('account.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            ltr
            required
            className="w-32"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" busy={change.busy} disabled={code.trim() === ''}>
            {t('account.codeProve')}
          </Button>
          <Button variant="tertiary" onClick={() => setStep('idle')}>
            {t('returns.cancel')}
          </Button>
        </form>
      )}
      {change.said}
    </div>
  );
}

/** The language Hatti's emails and messages to the account are in. */
function Language({ language }: { language: 'en' | 'ur' }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const change = useChange();
  const [chosen, setChosen] = useState(language);
  return (
    <div className="flex flex-col gap-2">
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-secondary">{t('account.language')}</legend>
        {(['en', 'ur'] as const).map((each) => (
          <label key={each} className="flex min-h-10 items-center gap-2">
            <input
              type="radio"
              name="language"
              checked={chosen === each}
              disabled={change.busy}
              onChange={() => {
                setChosen(each);
                void change.run(async () => {
                  setChosen(each);
                  try {
                    await store.auth('/auth/language', {
                      method: 'POST',
                      body: { language: each },
                    });
                  } catch (error) {
                    setChosen(language);
                    throw error;
                  }
                  return t('account.languageSaved');
                });
              }}
              className="size-5 accent-[var(--hatti-color-primary)]"
            />
            <span lang={each}>{each === 'en' ? 'English' : 'اردو'}</span>
          </label>
        ))}
      </fieldset>
      {change.said}
    </div>
  );
}

/**
 * The Google account connected to sign in with: connected through Google's own button, with a
 * nonce of the core's good once, and taken off where it is not the only way in.
 */
function Google({ google }: { google: { email: string } | null }) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const change = useChange();
  const [options, setOptions] = useState<GoogleOptions | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const start = async () => {
    setProblem(null);
    try {
      setOptions(await store.auth<GoogleOptions>('/auth/google/options', { method: 'POST' }));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Row label={t('account.google')}>
        {google ? (
          <span dir="ltr">{google.email}</span>
        ) : (
          <span className="text-secondary">{t('account.googleNone')}</span>
        )}
      </Row>
      {google && (
        <Button
          variant="danger"
          className="self-start"
          busy={change.busy}
          onClick={() =>
            void change.run(async () => {
              await store.auth('/auth/google', { method: 'DELETE' });
              return t('account.googleRemoved');
            })
          }
        >
          {t('account.googleRemove')}
        </Button>
      )}
      {!google &&
        (options ? (
          <GoogleButton
            options={options}
            onToken={(idToken) => {
              setOptions(null);
              void change.run(async () => {
                await store.auth('/auth/google', {
                  method: 'POST',
                  body: { idToken, language: locale },
                });
                return t('account.googleAdded');
              });
            }}
            onError={(failure) => {
              setOptions(null);
              setProblem(errorText(failure, t));
            }}
          />
        ) : (
          <Button
            variant="secondary"
            className="self-start"
            busy={change.busy}
            onClick={() => void start()}
          >
            {t('account.googleAdd')}
          </Button>
        ))}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {change.said}
    </div>
  );
}

/** Passkeys that sign the account in on this phone or another, added and taken off here. */
function Passkeys() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const timezone = useShopTimezone();
  const change = useChange();
  const query = useQuery({
    queryKey: PASSKEYS_KEY,
    queryFn: () => store.auth<{ passkeys: PasskeyInfo[] }>('/auth/passkeys'),
  });
  const [name, setName] = useState('');
  const works = passkeysWork();

  const add = (event: FormEvent) => {
    event.preventDefault();
    void change.run(async () => {
      const { options } = await store.auth<{ options: Parameters<typeof createPasskey>[0] }>(
        '/auth/passkeys/options',
        { method: 'POST' },
      );
      const response = await createPasskey(options);
      await store.auth('/auth/passkeys', {
        method: 'POST',
        body: { response, name: name.trim() || null },
      });
      setName('');
      return t('account.passkeyAdded');
    });
  };

  return (
    <FormSection title={t('account.passkeys')} hint={t('account.passkeysHint')}>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <Alert tone="danger">{errorText(query.error, t)}</Alert>
      ) : query.data.passkeys.length === 0 ? (
        <p className="text-secondary">{t('account.passkeysNone')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {query.data.passkeys.map((passkey) => (
            <li key={passkey.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <KeyRound aria-hidden className="size-5 shrink-0 text-secondary" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium" dir="auto">
                    {passkey.name}
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {passkey.lastUsedAt
                      ? t('account.lastUsed', {
                          date: formatDateTime(passkey.lastUsedAt, timezone, locale),
                        })
                      : t('account.added', {
                          date: formatDateTime(passkey.createdAt, timezone, locale),
                        })}
                  </span>
                </span>
              </span>
              <Button
                variant="danger"
                aria-label={t('account.passkeyRemove', { name: passkey.name })}
                icon={<Trash2 aria-hidden className="size-5" />}
                disabled={change.busy}
                onClick={() =>
                  void change.run(async () => {
                    await store.auth(`/auth/passkeys/${encodeURIComponent(passkey.id)}`, {
                      method: 'DELETE',
                    });
                    return t('account.passkeyRemoved');
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
      {works ? (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('account.passkeyName')}
            hint={t('account.passkeyNameHint')}
            dir="auto"
            className="w-56"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            type="submit"
            busy={change.busy}
            icon={<KeyRound aria-hidden className="size-5" />}
          >
            {t('account.passkeyAdd')}
          </Button>
        </form>
      ) : (
        <p className="text-secondary">{t('account.passkeysUnsupported')}</p>
      )}
      {change.said}
    </FormSection>
  );
}

/** The browsers the account is signed in on; any but this one signed out. */
function Sessions() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const timezone = useShopTimezone();
  const change = useChange();
  const query = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => store.auth<{ sessions: SessionInfo[] }>('/auth/sessions'),
  });
  return (
    <FormSection title={t('account.sessions')} hint={t('account.sessionsHint')}>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <Alert tone="danger">{errorText(query.error, t)}</Alert>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {query.data.sessions.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <MonitorSmartphone aria-hidden className="size-5 shrink-0 text-secondary" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {session.device}
                    {session.current && ` · ${t('account.thisBrowser')}`}
                  </span>
                  <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('account.lastUsed', {
                      date: formatDateTime(session.lastUsedAt, timezone, locale),
                    })}
                    {session.ip && (
                      <>
                        {' · '}
                        <span dir="ltr">{session.ip}</span>
                      </>
                    )}
                  </span>
                </span>
              </span>
              {!session.current && (
                <Button
                  variant="danger"
                  aria-label={t('account.signOutOf', { device: session.device })}
                  icon={<LogOut aria-hidden className="size-5 rtl:-scale-x-100" />}
                  disabled={change.busy}
                  onClick={() =>
                    void change.run(async () => {
                      await store.auth(`/auth/sessions/${encodeURIComponent(session.id)}`, {
                        method: 'DELETE',
                      });
                      return t('account.signedOut', { device: session.device });
                    })
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {change.said}
    </FormSection>
  );
}

/**
 * Your account (ADM-02): your email and number, each proved, changed or taken off; the language
 * Hatti writes to you in; Google, passkeys and the browsers you are signed in on.
 */
export function AccountPage() {
  const { t } = useLocale();
  const me = useMe();
  if (me.isPending) return <Loading label={t('state.loading')} />;
  if (me.isError || !me.data) {
    return (
      <ErrorState
        message={errorText(me.error, t)}
        action={<Button onClick={() => void me.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { user, google } = me.data;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('account.title')}
        </h1>
        <p className="text-secondary" dir="auto">
          {user.name}
        </p>
      </div>
      <FormSection title={t('account.contact')}>
        <Email email={user.email} proved={user.emailVerified ?? false} />
        <Phone phone={user.phone} proved={user.phoneVerified ?? false} />
        <Language language={user.language} />
      </FormSection>
      <FormSection title={t('account.signingIn')}>
        <Google google={google ?? null} />
      </FormSection>
      <Passkeys />
      <Sessions />
    </div>
  );
}
