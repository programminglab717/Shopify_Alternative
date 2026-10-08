import { Archive, ArrowDown, ArrowUp, Copy, CreditCard, Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  PaymentGatewayAccountArchiveMutation,
  PaymentGatewayAccountConnectMutation,
  PaymentGatewayAccountsReorderMutation,
  PaymentGatewaysQuery,
} from '../api/operations';
import type {
  PaymentGatewayAccountDetail,
  PaymentGatewayAccountPayloadData,
  PaymentGatewayOffered,
  PaymentGatewaysData,
  UserError,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField, Problems, SelectField } from './settings-form';
import { BackToSettings } from './settings-page';

/** The address a gateway sends its webhooks to, to copy into its dashboard. */
function WebhookUrl({ url }: { url: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('gateways.webhook')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="num min-w-0 flex-1 break-all rounded-control bg-canvas px-2 py-1"
          dir="ltr"
        >
          {url}
        </code>
        <Button
          variant="tertiary"
          icon={<Copy aria-hidden className="size-5" />}
          onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}
        >
          {copied ? t('staff.copied') : t('gateways.copy')}
        </Button>
      </div>
    </div>
  );
}

/** Connecting the shop's account with a gateway, with what its dashboard gives, sealed. */
function ConnectForm({
  gateways,
  onDone,
}: {
  gateways: PaymentGatewayOffered[];
  onDone: (account: PaymentGatewayAccountDetail) => void;
}) {
  const { t } = useLocale();
  const { run, panel } = useRecentAuthentication();
  const connect = useAdminMutation<
    { paymentGatewayAccountConnect: PaymentGatewayAccountPayloadData },
    { input: Record<string, unknown> }
  >(PaymentGatewayAccountConnectMutation);
  const [gateway, setGateway] = useState(gateways[0]?.gateway ?? '');
  const [sandbox, setSandbox] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const chosen = gateways.find((each) => each.gateway === gateway);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    setProblems([]);
    const credentials = chosen.credentials
      .map((field) => ({ key: field.key, value: (values[field.key] ?? '').trim() }))
      .filter((credential) => credential.value);
    void run(
      async () => {
        const { paymentGatewayAccountConnect: payload } = await connect.mutateAsync({
          input: { gateway, environment: sandbox ? 'SANDBOX' : 'PRODUCTION', credentials },
        });
        if (payload.userErrors.length > 0) {
          setProblems(payload.userErrors.map((error) => problemText(error, t)));
        } else if (payload.paymentGatewayAccount) onDone(payload.paymentGatewayAccount);
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <h2 className="font-semibold">{t('gateways.connect')}</h2>
          <SelectField
            label={t('gateways.gateway')}
            value={gateway}
            options={gateways.map((each) => ({ value: each.gateway, label: each.name }))}
            onChange={(next) => {
              setGateway(next);
              setValues({});
            }}
          />
          {chosen?.test && <Alert tone="info">{t('gateways.testGateway')}</Alert>}
          {chosen?.credentials.map((field) => (
            <TextField
              key={`${gateway}-${field.key}`}
              label={field.optional ? t('gateways.optional', { label: field.label }) : field.label}
              type="password"
              autoComplete="off"
              ltr
              required={!field.optional}
              value={values[field.key] ?? ''}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          ))}
          <CheckField
            label={t('gateways.sandbox')}
            hint={t('gateways.sandboxHint')}
            checked={sandbox}
            onChange={setSandbox}
          />
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('couriers.sealed')}
          </p>
          <Problems problems={problems} />
          <Button type="submit" busy={connect.isPending} className="self-start">
            {t('couriers.connectSubmit')}
          </Button>
        </form>
      </Card>
      {panel}
    </div>
  );
}

function AccountRow({
  account,
  refunds,
  first,
  last,
  busy,
  onMove,
}: {
  account: PaymentGatewayAccountDetail;
  refunds: PaymentGatewayOffered['refunds'] | undefined;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (by: -1 | 1) => void;
}) {
  const { t } = useLocale();
  const archive = useAdminMutation<
    { paymentGatewayAccountArchive: { userErrors: UserError[] } },
    { id: string }
  >(PaymentGatewayAccountArchiveMutation);
  const [archiving, setArchiving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onArchive = async () => {
    setProblem(null);
    try {
      const { paymentGatewayAccountArchive } = await archive.mutateAsync({ id: account.id });
      const error = paymentGatewayAccountArchive.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CreditCard aria-hidden className="size-5 text-secondary" />
        <span className="font-medium">{account.gatewayName}</span>
        {account.environment === 'SANDBOX' && (
          <span className="rounded-full bg-canvas px-2 text-[length:var(--hatti-type-body-sm-size)] font-medium text-warning">
            {t('gateways.sandboxBadge')}
          </span>
        )}
        <span className="flex-1" />
        <span className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('couriers.credentialsHint', { hint: account.credentialsHint })}
        </span>
      </div>
      {refunds && (
        <p className="text-secondary">{t(`gateways.refunds.${refunds}` as MessageKey)}</p>
      )}
      <WebhookUrl url={account.webhookUrl} />
      <div className="flex flex-wrap gap-2">
        {!first && (
          <Button
            variant="tertiary"
            icon={<ArrowUp aria-hidden className="size-5" />}
            disabled={busy}
            onClick={() => onMove(-1)}
          >
            {t('gateways.up')}
          </Button>
        )}
        {!last && (
          <Button
            variant="tertiary"
            icon={<ArrowDown aria-hidden className="size-5" />}
            disabled={busy}
            onClick={() => onMove(1)}
          >
            {t('gateways.down')}
          </Button>
        )}
        {archiving ? (
          <>
            <span className="self-center">{t('gateways.archiveSure')}</span>
            <Button variant="destructive" busy={archive.isPending} onClick={() => void onArchive()}>
              {t('couriers.archiveYes')}
            </Button>
            <Button variant="tertiary" onClick={() => setArchiving(false)}>
              {t('action.back')}
            </Button>
          </>
        ) : (
          <Button
            variant="danger"
            icon={<Archive aria-hidden className="size-5" />}
            onClick={() => setArchiving(true)}
          >
            {t('couriers.archive')}
          </Button>
        )}
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
    </li>
  );
}

/**
 * Online payments (PAY-01, PAY-05): the shop's accounts with payment gateways, in the order its
 * customers are offered them, each with the address its dashboard sends webhooks to; another
 * connected once the member confirms who they are, or one archived. The Free plan connects none,
 * which the core says.
 */
export function OnlinePaymentsPage() {
  const { t } = useLocale();
  const query = useAdminQuery<PaymentGatewaysData>(['paymentGateways'], PaymentGatewaysQuery);
  const reorder = useAdminMutation<
    { paymentGatewayAccountsReorder: { userErrors: UserError[] } },
    { ids: string[] }
  >(PaymentGatewayAccountsReorderMutation);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState<PaymentGatewayAccountDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { paymentGateways: gateways, paymentGatewayAccounts: accounts } = query.data;
  // One live account a gateway: those connected already are not offered again.
  const open = gateways.filter(
    (each) => !accounts.some((account) => account.gateway === each.gateway),
  );
  const showForm = open.length > 0 && (connecting || accounts.length === 0);

  const onMove = async (index: number, by: -1 | 1) => {
    const ids = accounts.map((account) => account.id);
    [ids[index], ids[index + by]] = [ids[index + by]!, ids[index]!];
    setProblem(null);
    try {
      const { paymentGatewayAccountsReorder } = await reorder.mutateAsync({ ids });
      const error = paymentGatewayAccountsReorder.userErrors[0];
      if (error) setProblem(problemText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('settings.onlinePayments')}
      </h1>
      {connected && (
        <Alert tone="success">
          <div className="flex flex-col gap-2">
            <span>{t('gateways.connected', { gateway: connected.gatewayName })}</span>
            <WebhookUrl url={connected.webhookUrl} />
          </div>
        </Alert>
      )}
      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CreditCard aria-hidden className="size-8 text-secondary" />}
            title={t('gateways.none')}
            body={t('gateways.noneBody')}
          />
        </Card>
      ) : (
        <Card>
          {accounts.length > 1 && (
            <p className="border-b border-line px-4 py-2 text-secondary">{t('gateways.order')}</p>
          )}
          <ul className="divide-y divide-line">
            {accounts.map((account, index) => (
              <AccountRow
                key={account.id}
                account={account}
                refunds={gateways.find((each) => each.gateway === account.gateway)?.refunds}
                first={index === 0}
                last={index === accounts.length - 1}
                busy={reorder.isPending}
                onMove={(by) => void onMove(index, by)}
              />
            ))}
          </ul>
        </Card>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {showForm ? (
        <ConnectForm
          gateways={open}
          onDone={(account) => {
            setConnecting(false);
            setConnected(account);
          }}
        />
      ) : (
        open.length > 0 && (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setConnecting(true);
              setConnected(null);
            }}
          >
            {t('gateways.connectAnother')}
          </Button>
        )
      )}
    </div>
  );
}
