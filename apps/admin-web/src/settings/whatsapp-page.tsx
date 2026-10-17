import { CircleCheck, CircleDashed, CircleAlert, MessageCircle, Unplug } from 'lucide-react';
import { useState } from 'react';
import {
  WhatsAppAccountConnectMutation,
  WhatsAppAccountDisconnectMutation,
  WhatsAppAccountQuery,
} from '../api/operations';
import type {
  WhatsAppAccount,
  WhatsAppAccountConnectData,
  WhatsAppAccountData,
  WhatsAppAccountDisconnectData,
  WhatsAppOrderTemplates,
  WhatsAppQualityRating,
  WhatsAppSignup,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { BackToSettings } from './settings-page';
import { embeddedSignup } from './whatsapp-signup';

/** How Meta rates the number's messages, as a badge. */
const QUALITY = {
  GREEN: { colour: 'delivered', icon: CircleCheck },
  YELLOW: { colour: 'needsConfirmation', icon: CircleAlert },
  RED: { colour: 'cancelled', icon: CircleAlert },
  UNKNOWN: { colour: 'inTransit', icon: CircleDashed },
} as const satisfies Record<WhatsAppQualityRating, unknown>;

/**
 * Which number the shop's customers' order news goes from (ADR-537): this one for the kinds whose
 * templates Meta approved on it, Hatti's for the rest.
 */
function OrderUpdates({ templates }: { templates: WhatsAppOrderTemplates }) {
  const { t } = useLocale();
  const { total, approved, pending, refused, triedAt } = templates;
  const said =
    approved >= total
      ? t('whatsapp.orderUpdatesAll')
      : approved > 0
        ? t('whatsapp.orderUpdatesSome', { approved, total })
        : pending > 0 || triedAt
          ? t('whatsapp.orderUpdatesWaiting')
          : t('whatsapp.orderUpdatesSoon');
  return (
    <p className="text-[length:var(--hatti-type-body-sm-size)]" data-testid="order-updates">
      {said}
      {refused > 0 && ` ${t('whatsapp.orderUpdatesRefused', { count: refused })}`}
    </p>
  );
}

/** The number connected: its name and number with WhatsApp, its quality, and disconnecting it. */
function Connected({
  account,
  templates,
}: {
  account: WhatsAppAccount;
  templates: WhatsAppOrderTemplates | null;
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const disconnect = useAdminMutation<WhatsAppAccountDisconnectData, Record<string, never>>(
    WhatsAppAccountDisconnectMutation,
  );
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const quality = QUALITY[account.qualityRating];

  const onDisconnect = async () => {
    setProblem(null);
    try {
      const error = (await disconnect.mutateAsync({})).whatsAppAccountDisconnect.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
    setAsking(false);
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-medium" dir="auto">
            {account.verifiedName}
          </span>
          <span dir="ltr" className="text-start">
            {account.displayPhoneNumber}
          </span>
        </span>
        <Badge
          colour={quality.colour}
          icon={quality.icon}
          label={t(`whatsapp.quality.${account.qualityRating}` as MessageKey)}
        />
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('whatsapp.connectedOn', {
          date: formatDateTime(account.connectedAt, timezone, locale),
        })}
      </p>
      {templates && <OrderUpdates templates={templates} />}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {asking ? (
        <div className="flex flex-col gap-2">
          <p>{t('whatsapp.disconnectSure', { number: account.displayPhoneNumber })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={disconnect.isPending}
              onClick={() => void onDisconnect()}
            >
              {t('whatsapp.disconnectYes')}
            </Button>
            <Button variant="tertiary" onClick={() => setAsking(false)}>
              {t('action.back')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<Unplug aria-hidden className="size-5" />}
          onClick={() => setAsking(true)}
        >
          {t('whatsapp.disconnect')}
        </Button>
      )}
    </Card>
  );
}

/**
 * No number yet: Meta's Embedded Signup, in Facebook's own window, where the shop chooses or adds
 * its number; the core then connects it with the code Facebook gave.
 */
function Connect({ signup }: { signup: WhatsAppSignup | null }) {
  const { t } = useLocale();
  const connect = useAdminMutation<
    WhatsAppAccountConnectData,
    { input: { code: string; businessAccountId: string; phoneNumberId: string } }
  >(WhatsAppAccountConnectMutation);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  if (!signup) {
    return <Alert tone="warning">{t('whatsapp.notSetUp')}</Alert>;
  }

  const onConnect = async () => {
    setProblem(null);
    setClosed(false);
    setWorking(true);
    try {
      const chosen = await embeddedSignup(signup);
      if (!chosen) {
        setClosed(true);
        return;
      }
      const error = (await connect.mutateAsync({ input: chosen })).whatsAppAccountConnect
        .userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="font-medium">{t('whatsapp.connectTitle')}</h2>
      <ol className="flex list-decimal flex-col gap-1 ps-5">
        <li>{t('whatsapp.step1')}</li>
        <li>{t('whatsapp.step2')}</li>
        <li>{t('whatsapp.step3')}</li>
      </ol>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('whatsapp.ownNumberHint')}
      </p>
      {closed && <Alert tone="info">{t('whatsapp.closed')}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button
        className="self-start"
        busy={working}
        icon={<MessageCircle aria-hidden className="size-5" />}
        onClick={() => void onConnect()}
      >
        {t('whatsapp.connect')}
      </Button>
    </Card>
  );
}

/**
 * The shop's own WhatsApp number (MKT-01, ADR-419), which its broadcasts go from, and its
 * customers' order news once Meta approves Hatti's templates on it (ADR-537): connected through
 * Meta's Embedded Signup, shown with Meta's rating of it and how far Meta has come with those
 * templates, and disconnected.
 */
export function WhatsAppPage() {
  const { t } = useLocale();
  const query = useAdminQuery<WhatsAppAccountData>(['whatsAppAccount'], WhatsAppAccountQuery);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <MessageCircle aria-hidden className="size-7 text-secondary" />
        {t('whatsapp.title')}
      </h1>
      <p className="text-secondary">{t('whatsapp.intro')}</p>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : query.data.whatsAppAccount ? (
        <Connected
          account={query.data.whatsAppAccount}
          templates={query.data.whatsAppOrderTemplates ?? null}
        />
      ) : (
        <Connect signup={query.data.whatsAppSignup} />
      )}
    </div>
  );
}
