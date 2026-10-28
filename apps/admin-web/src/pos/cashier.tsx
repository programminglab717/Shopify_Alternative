import { KeyRound, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PosCashierSignInMutation,
  PosPinQuery,
  PosPinRemoveMutation,
  PosPinSetMutation,
} from '../api/operations';
import type {
  PosCashierSignInData,
  PosCashierValue,
  PosPinData,
  PosPinPayloadData,
} from '../api/types';
import { useMe } from '../auth/context';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The cashier signed in at this till for a session, kept in this tab alone. */
const CASHIER_KEY = (sessionId: string) => `hatti.pos.cashier.${sessionId}`;

export function keptCashier(sessionId: string, now = Date.now()): PosCashierValue | null {
  try {
    const kept = JSON.parse(
      window.sessionStorage.getItem(CASHIER_KEY(sessionId)) ?? 'null',
    ) as PosCashierValue | null;
    return kept && Date.parse(kept.expiresAt) > now ? kept : null;
  } catch {
    return null;
  }
}

function keepCashier(sessionId: string, cashier: PosCashierValue | null): void {
  try {
    if (cashier) window.sessionStorage.setItem(CASHIER_KEY(sessionId), JSON.stringify(cashier));
    else window.sessionStorage.removeItem(CASHIER_KEY(sessionId));
  } catch {
    // Signed in for this page alone.
  }
}

/**
 * Who rings up sales at a shared till (POS-07, ADR-874): the cashier signed in with their PIN,
 * whose sales name them, or a sign-in. Signing in needs a connection; the sales after it, offline
 * too, carry the cashier's token.
 */
export function CashierBar({
  sessionId,
  cashier,
  onChange,
}: {
  sessionId: string;
  cashier: PosCashierValue | null;
  onChange: (cashier: PosCashierValue | null) => void;
}) {
  const { t } = useLocale();
  const signIn = useAdminMutation<PosCashierSignInData, { sessionId: string; pin: string }>(
    PosCashierSignInMutation,
  );
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      const { posCashierSignIn } = await signIn.mutateAsync({ sessionId, pin });
      const error = posCashierSignIn.userErrors[0];
      if (error || !posCashierSignIn.cashier) {
        setProblem(error ? problemText(error, t) : t('pos.cashierFailed'));
        return;
      }
      keepCashier(sessionId, posCashierSignIn.cashier);
      onChange(posCashierSignIn.cashier);
      setPin('');
      setOpen(false);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <UserRound aria-hidden className="size-5 text-secondary" />
        <span className="font-medium">
          {cashier ? t('pos.cashierIs', { name: cashier.name }) : t('pos.noCashier')}
        </span>
        <Button variant="tertiary" onClick={() => setOpen(!open)}>
          {cashier ? t('pos.switchCashier') : t('pos.signInCashier')}
        </Button>
        {cashier && (
          <Button
            variant="tertiary"
            onClick={() => {
              keepCashier(sessionId, null);
              onChange(null);
            }}
          >
            {t('pos.signOutCashier')}
          </Button>
        )}
      </div>
      {open && (
        <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2">
          <TextField
            label={t('pos.pin')}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            ltr
            autoFocus
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
          />
          <Button type="submit" busy={signIn.isPending} disabled={pin.length < 4}>
            {t('pos.signIn')}
          </Button>
        </form>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/** The signed-in member of staff's own till PIN: set, changed, or taken away. */
export function MyPin() {
  const { t } = useLocale();
  const me = useMe();
  const mine = useAdminQuery<PosPinData>(['posPin'], PosPinQuery);
  const set = useAdminMutation<PosPinPayloadData, { pin: string; name: string }>(PosPinSetMutation);
  const remove = useAdminMutation<PosPinPayloadData, Record<string, never>>(PosPinRemoveMutation);
  const [pin, setPin] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  if (mine.isPending) return <Loading label={t('state.loading')} />;
  const current = mine.data?.posPin;
  const shown = name ?? current?.name ?? me.data?.user.name ?? '';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaid(null);
    try {
      const { posPinSet } = await set.mutateAsync({ pin, name: shown });
      const error = posPinSet?.userErrors[0];
      if (error) setSaid({ tone: 'danger', text: problemText(error, t) });
      else {
        setPin('');
        setSaid({ tone: 'success', text: t('pos.pinSaved') });
      }
    } catch (failure) {
      setSaid({ tone: 'danger', text: errorText(failure, t) });
    }
  };
  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="flex items-center gap-2 text-[length:var(--hatti-type-title-size)] font-semibold">
        <KeyRound aria-hidden className="size-5" />
        {t('pos.myPin')}
      </h2>
      <p className="text-secondary">{current?.set ? t('pos.pinIsSet') : t('pos.pinHint')}</p>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <TextField
          label={t('pos.pinName')}
          maxLength={80}
          value={shown}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={current?.set ? t('pos.newPin') : t('pos.pin')}
          hint={t('pos.pinRules')}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={6}
          ltr
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        />
        {said && <Alert tone={said.tone}>{said.text}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={set.isPending} disabled={pin.length < 4 || !shown.trim()}>
            {t('pos.savePin')}
          </Button>
          {current?.set && (
            <Button
              variant="danger"
              busy={remove.isPending}
              onClick={() => void remove.mutateAsync({}).then(() => setSaid(null))}
            >
              {t('pos.removePin')}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
