import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  PushNotificationsQuery,
  PushSubscribeMutation,
  PushUnsubscribeMutation,
} from '../api/operations';
import type { UserError } from '../api/types';
import { gate, permits, type Gate } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { CheckField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import {
  currentSubscription,
  notificationsBlocked,
  pushSupport,
  subscribeBrowser,
  unsubscribeBrowser,
} from './push';

type PushKind = 'NEW_ORDER' | 'NEEDS_REVIEW' | 'CASH_REMITTED' | 'LOW_STOCK';

/**
 * Whose work each kind of news is, and what it needs of them, as the core pushes it (ADR-506,
 * ADR-581): a custom role's member is offered only the news of work they may do.
 */
const KINDS: {
  kind: PushKind;
  gate: Gate;
  label: MessageKey;
  hint: MessageKey;
}[] = [
  {
    kind: 'NEW_ORDER',
    gate: gate(['owner', 'manager', 'confirmation_agent'], 'write_orders'),
    label: 'push.newOrder',
    hint: 'push.newOrderHint',
  },
  {
    kind: 'NEEDS_REVIEW',
    gate: gate(['owner', 'manager', 'confirmation_agent'], 'write_orders'),
    label: 'push.needsReview',
    hint: 'push.needsReviewHint',
  },
  {
    kind: 'CASH_REMITTED',
    gate: gate(['owner', 'manager', 'accountant'], 'reconcile_payments'),
    label: 'push.cashRemitted',
    hint: 'push.cashRemittedHint',
  },
  {
    kind: 'LOW_STOCK',
    gate: gate(['owner', 'manager'], 'write_inventory'),
    label: 'push.lowStock',
    hint: 'push.lowStockHint',
  },
];

interface PushData {
  pushNotifications: {
    publicKey: string | null;
    subscription: { endpoint: string; kinds: PushKind[] } | null;
  };
}

interface SubscribeData {
  pushSubscribe: {
    subscription: { endpoint: string; kinds: PushKind[] } | null;
    userErrors: UserError[];
  };
}

/**
 * The shop's news on this phone or computer (APP-03, ADR-506): a member of staff turns
 * notifications on in this browser for the kinds their role does, changes them, or turns them
 * off. Each browser is its own: a phone and a laptop are turned on apart.
 */
export function PushNotifications() {
  const { t } = useLocale();
  const shop = useShop();
  const support = pushSupport();
  const browser = useQuery({
    queryKey: ['push', 'browser'],
    queryFn: currentSubscription,
    enabled: support === 'yes',
  });
  const endpoint = browser.data?.endpoint ?? null;
  const query = useAdminQuery<PushData>(
    ['push', endpoint],
    PushNotificationsQuery,
    { endpoint },
    { enabled: support === 'yes' && browser.isSuccess },
  );
  const subscribe = useAdminMutation<SubscribeData, { input: Record<string, unknown> }>(
    PushSubscribeMutation,
  );
  const unsubscribe = useAdminMutation<unknown, { endpoint: string }>(PushUnsubscribeMutation);
  const offered = KINDS.filter((each) => permits(shop, each.gate));
  const [chosen, setChosen] = useState<PushKind[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const section = (children: ReactNode) => (
    <FormSection title={t('push.title')} hint={t('push.hint')}>
      {children}
    </FormSection>
  );
  if (support === 'install') return section(<p className="text-secondary">{t('push.install')}</p>);
  if (support === 'no') return section(<p className="text-secondary">{t('push.unsupported')}</p>);
  if (browser.isPending || query.isPending) return section(<Loading label={t('state.loading')} />);
  if (browser.isError || query.isError) {
    return section(<Alert tone="danger">{errorText(browser.error ?? query.error, t)}</Alert>);
  }
  const { publicKey, subscription } = query.data.pushNotifications;
  if (!publicKey) return section(<p className="text-secondary">{t('push.off')}</p>);
  if (offered.length === 0) return section(<p className="text-secondary">{t('push.none')}</p>);

  const kinds = chosen ?? subscription?.kinds ?? offered.map((each) => each.kind);
  const toggle = (kind: PushKind, on: boolean) =>
    setChosen(on ? [...new Set([...kinds, kind])] : kinds.filter((each) => each !== kind));

  const act = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const said = await action();
      if (said) setDone(said);
      await browser.refetch();
    } catch (error) {
      setProblem(errorText(error, t));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      const keys = await subscribeBrowser(publicKey);
      if (!keys) {
        setProblem(t(notificationsBlocked() ? 'push.blocked' : 'push.notAllowed'));
        return null;
      }
      const result = await subscribe.mutateAsync({ input: { ...keys, kinds } });
      const [error] = result.pushSubscribe.userErrors;
      if (error) {
        setProblem(error.message);
        return null;
      }
      setChosen(null);
      return t(subscription ? 'push.saved' : 'push.turnedOn');
    });

  const turnOff = () =>
    act(async () => {
      if (subscription) await unsubscribe.mutateAsync({ endpoint: subscription.endpoint });
      await unsubscribeBrowser();
      setChosen(null);
      return t('push.turnedOff');
    });

  return section(
    <div className="flex flex-col gap-3">
      {subscription ? (
        <p className="flex items-center gap-2 text-success">
          <BellRing aria-hidden className="size-5" />
          {t('push.onHere')}
        </p>
      ) : (
        notificationsBlocked() && <Alert tone="warning">{t('push.blocked')}</Alert>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">{t('push.kinds')}</legend>
        {offered.map((each) => (
          <CheckField
            key={each.kind}
            label={t(each.label)}
            hint={t(each.hint)}
            checked={kinds.includes(each.kind)}
            onChange={(on) => toggle(each.kind, on)}
          />
        ))}
      </fieldset>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done && <Alert tone="success">{done}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy || kinds.length === 0}>
          {t(subscription ? 'push.save' : 'push.turnOn')}
        </Button>
        {subscription && (
          <Button variant="secondary" onClick={() => void turnOff()} disabled={busy}>
            {t('push.turnOff')}
          </Button>
        )}
      </div>
    </div>,
  );
}
