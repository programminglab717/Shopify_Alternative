import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { getPasskey, passkeysWork, passkeyTurnedAway } from '../account/webauthn';
import { ApiError } from '../api/client';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Button } from '../ui/button';
import { Alert, Card, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { useSessionStore } from './context';
import { GoogleButton } from './google';
import type { GoogleOptions } from './google';

/** The ways a member confirms who they are, the first their account takes offered first. */
type Way = 'passkey' | 'totp' | 'password' | 'google' | 'phone';

const WAYS: readonly Way[] = ['passkey', 'totp', 'password', 'google', 'phone'];

interface Options {
  methods: string[];
  passkeyOptions: Parameters<typeof getPasskey>[0] | null;
  googleOptions: GoogleOptions | null;
  phone: string | null;
}

/** The ways these options take here: a passkey where the browser has them, Google where set up. */
const waysOf = (options: Options) =>
  WAYS.filter(
    (way) =>
      options.methods.includes(way) &&
      (way !== 'passkey' || (options.passkeyOptions && passkeysWork())) &&
      (way !== 'google' || options.googleOptions),
  );

/**
 * Asks the signed-in member to confirm who they are (ADR-103): a passkey, a code from their
 * authenticator app, their password, Google, or a code sent to their number, as their account
 * takes them. The core then lets them do sensitive things for 15 minutes. A passkey's challenge
 * and Google's nonce are good once, so a try that fails asks the core for new options.
 */
function ConfirmIdentity({
  onConfirmed,
  onCancel,
}: {
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const [options, setOptions] = useState<Options | null>(null);
  const [way, setWay] = useState<Way | null>(null);
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    store
      .auth<Options>('/auth/reauthenticate/options', { method: 'POST' })
      .then((answer) => {
        if (!live) return;
        setOptions(answer);
        setWay((chosen) => {
          const ways = waysOf(answer);
          return chosen && ways.includes(chosen) ? chosen : (ways[0] ?? null);
        });
      })
      .catch((failure: unknown) => live && setProblem(errorText(failure, t)));
    return () => {
      live = false;
    };
  }, [store, t, round]);

  /** Confirms with `proof`; a failure says why, and fetches options good for another try. */
  const confirm = async (proof: () => Promise<Record<string, unknown>>) => {
    setProblem(null);
    setBusy(true);
    try {
      await store.auth('/auth/reauthenticate', { method: 'POST', body: await proof() });
      onConfirmed();
    } catch (failure) {
      setProblem(
        passkeyTurnedAway(failure) ? t('signIn.passkeyTurnedAway') : errorText(failure, t),
      );
      setRound((count) => count + 1);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    setProblem(null);
    setBusy(true);
    try {
      await store.auth('/auth/reauthenticate/code', {
        method: 'POST',
        body: { channel: 'whatsapp', language: locale },
      });
      setSent(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!way) return;
    setProblem(null);
    setBusy(true);
    try {
      const proof = value.trim();
      await store.auth('/auth/reauthenticate', {
        method: 'POST',
        body:
          way === 'totp'
            ? { code: proof }
            : way === 'password'
              ? { password: value }
              : { phoneCode: proof },
      });
      onConfirmed();
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const others = options ? waysOf(options).filter((each) => each !== way) : [];
  const typed = way === 'totp' || way === 'password' || way === 'phone';
  return (
    <Card className="flex flex-col gap-3 border-primary p-4">
      <h2 className="inline-flex items-center gap-2 font-semibold">
        <ShieldCheck aria-hidden className="size-5 text-primary" />
        {t('confirm.title')}
      </h2>
      <p className="text-secondary">{t('confirm.body')}</p>
      {!options && !problem && <Loading label={t('state.loading')} />}
      {options && !way && <Alert tone="warning">{t('confirm.noWay')}</Alert>}
      {way === 'passkey' && options?.passkeyOptions && (
        <Button
          busy={busy}
          icon={<KeyRound aria-hidden className="size-5" />}
          onClick={() => {
            const passkeyOptions = options.passkeyOptions!;
            void confirm(async () => ({ passkey: await getPasskey(passkeyOptions) }));
          }}
        >
          {t('confirm.passkey')}
        </Button>
      )}
      {way === 'google' && options?.googleOptions && (
        <GoogleButton
          options={options.googleOptions}
          onToken={(googleIdToken) => void confirm(async () => ({ googleIdToken }))}
          onError={(failure) => setProblem(errorText(failure, t))}
        />
      )}
      {way && !typed && (
        <>
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant="tertiary" onClick={onCancel}>
              {t('action.back')}
            </Button>
            {others.map((other) => (
              <Button
                key={other}
                variant="tertiary"
                onClick={() => {
                  setWay(other);
                  setValue('');
                  setProblem(null);
                }}
              >
                {t(`confirm.use.${other}` as MessageKey)}
              </Button>
            ))}
          </div>
        </>
      )}
      {way && typed && (
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
          {way === 'phone' && !sent ? (
            <Button variant="secondary" busy={busy} onClick={() => void sendCode()}>
              {t('confirm.sendCode', { phone: options?.phone ?? '' })}
            </Button>
          ) : (
            <TextField
              label={t(`confirm.${way}` as MessageKey)}
              type={way === 'password' ? 'password' : 'text'}
              inputMode={way === 'password' ? undefined : 'numeric'}
              autoComplete={way === 'password' ? 'current-password' : 'one-time-code'}
              ltr
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required
            />
          )}
          {problem && <Alert tone="danger">{problem}</Alert>}
          <div className="flex flex-wrap gap-2">
            {(way !== 'phone' || sent) && (
              <Button type="submit" busy={busy}>
                {t('confirm.submit')}
              </Button>
            )}
            <Button variant="tertiary" onClick={onCancel}>
              {t('action.back')}
            </Button>
          </div>
          {others.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {others.map((other) => (
                <Button
                  key={other}
                  variant="tertiary"
                  onClick={() => {
                    setWay(other);
                    setValue('');
                    setProblem(null);
                  }}
                >
                  {t(`confirm.use.${other}` as MessageKey)}
                </Button>
              ))}
            </div>
          )}
        </form>
      )}
      {!way && problem && <Alert tone="danger">{problem}</Alert>}
    </Card>
  );
}

/**
 * Runs actions the core may refuse until the member has confirmed who they are lately: the
 * refused one waits while they confirm in `panel`, then runs again. Any other failure, the first
 * time or after confirming, goes to `onError`.
 */
export function useRecentAuthentication(): {
  run: (action: () => Promise<void>, onError: (failure: unknown) => void) => Promise<void>;
  panel: ReactNode;
} {
  const [waiting, setWaiting] = useState<{
    action: () => Promise<void>;
    onError: (failure: unknown) => void;
  } | null>(null);

  const run = async (action: () => Promise<void>, onError: (failure: unknown) => void) => {
    try {
      await action();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'REAUTHENTICATION_REQUIRED') {
        setWaiting({ action, onError });
      } else onError(failure);
    }
  };

  const panel = waiting ? (
    <ConfirmIdentity
      onCancel={() => setWaiting(null)}
      onConfirmed={() => {
        setWaiting(null);
        void run(waiting.action, waiting.onError);
      }}
    />
  ) : null;

  return { run, panel };
}
