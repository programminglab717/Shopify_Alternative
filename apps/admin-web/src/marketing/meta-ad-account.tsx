import { Link2, Link2Off, Pencil, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  MetaAdAccountConnectMutation,
  MetaAdAccountDisconnectMutation,
  MetaAdAccountQuery,
  MetaAdSpendSyncMutation,
} from '../api/operations';
import type {
  MetaAdAccount,
  MetaAdAccountConnectData,
  MetaAdAccountData,
  MetaAdAccountDisconnectData,
  MetaAdSpendSyncData,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText, userErrorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { Problems, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** The form's fields, as the API names them in its problems. */
const LABELS: Partial<Record<string, MessageKey>> = {
  adAccountId: 'adSpend.metaAccount.id',
  accessToken: 'meta.accessToken',
};
type Field = 'adAccountId' | 'accessToken';
const FIELDS: readonly Field[] = ['adAccountId', 'accessToken'];

/**
 * Connecting the shop's Meta ad account, or another in its place, or a new token for it: its ID,
 * and a token with ads_read, sealed and never shown again, sent once the member confirms who they
 * are. A problem with a field shows under it; any other, the plan's among them, above the button.
 */
function ConnectForm({
  current,
  onConnected,
}: {
  current: MetaAdAccount | null;
  onConnected: () => void;
}) {
  const { t } = useLocale();
  const connect = useAdminMutation<
    MetaAdAccountConnectData,
    { input: { adAccountId: string; accessToken: string } }
  >(MetaAdAccountConnectMutation);
  const { run, panel } = useRecentAuthentication();
  const [adAccountId, setAdAccountId] = useState(current?.adAccountId ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const ready = adAccountId.trim() !== '' && accessToken.trim() !== '';

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setErrors({});
    setProblems([]);
    void run(
      async () => {
        const { metaAdAccountConnect } = await connect.mutateAsync({
          input: { adAccountId: adAccountId.trim(), accessToken: accessToken.trim() },
        });
        if (metaAdAccountConnect.userErrors.length > 0 || !metaAdAccountConnect.metaAdAccount) {
          const under: Partial<Record<Field, string>> = {};
          const general: string[] = [];
          for (const error of metaAdAccountConnect.userErrors) {
            const field = error.field ?? [];
            const named = field[1] as Field | undefined;
            if (field.length === 2 && field[0] === 'input' && named && FIELDS.includes(named)) {
              under[named] = userErrorText(error, t);
            } else general.push(settingProblem(error, t, LABELS));
          }
          setErrors(under);
          setProblems(general);
          return;
        }
        setAccessToken('');
        onConnected();
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t('adSpend.metaAccount.id')}
        hint={t('adSpend.metaAccount.idHint')}
        autoComplete="off"
        ltr
        required
        className="max-w-xs"
        value={adAccountId}
        error={errors.adAccountId}
        onChange={(event) => setAdAccountId(event.target.value)}
      />
      <TextField
        label={t(current ? 'meta.newAccessToken' : 'meta.accessToken')}
        hint={t('adSpend.metaAccount.tokenHint')}
        type="password"
        autoComplete="off"
        ltr
        required
        value={accessToken}
        error={errors.accessToken}
        onChange={(event) => setAccessToken(event.target.value)}
      />
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('couriers.sealed')}
      </p>
      <Problems problems={problems} />
      <Button
        type="submit"
        className="self-start"
        busy={connect.isPending}
        disabled={!ready}
        icon={<Link2 aria-hidden className="size-5" />}
      >
        {t('adSpend.metaAccount.connect')}
      </Button>
    </form>
  );
  // Confirming who they are has a form of its own, so it sits beside this one, not in it.
  return (
    <>
      {form}
      {panel}
    </>
  );
}

/**
 * The connected ad account: its name, ID and currency, its token as its last four characters,
 * when its spend was last pulled and why that failed, if it did.
 */
function Connected({ account }: { account: MetaAdAccount }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const rows: { label: MessageKey; value: string; ltr: boolean }[] = [
    { label: 'adSpend.metaAccount.name', value: account.name, ltr: false },
    { label: 'adSpend.metaAccount.id', value: account.adAccountId, ltr: true },
    { label: 'adSpend.metaAccount.currency', value: account.currency, ltr: true },
    { label: 'meta.accessToken', value: `•••• ${account.accessTokenHint}`, ltr: true },
    {
      label: 'adSpend.metaAccount.lastPulled',
      value: account.lastSyncedAt
        ? formatDateTime(account.lastSyncedAt, timezone, locale)
        : t('adSpend.metaAccount.notPulled'),
      ltr: false,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="success">{t('adSpend.metaAccount.connected', { name: account.name })}</Alert>
      {account.lastError && (
        <Alert tone="warning">
          <p>{t('adSpend.metaAccount.lastError')}</p>
          <p dir="auto" className="break-words">
            {account.lastError}
          </p>
        </Alert>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-secondary">{t(row.label)}</dt>
            <dd
              className={row.ltr ? 'num break-all' : 'break-words'}
              dir={row.ltr ? 'ltr' : 'auto'}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Pulling its spend now, as the worker does every few hours: at most once a minute. */
function PullNow() {
  const { t } = useLocale();
  const sync = useAdminMutation<MetaAdSpendSyncData, Record<string, never>>(
    MetaAdSpendSyncMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [pulled, setPulled] = useState(false);

  const onPull = async () => {
    setProblem(null);
    setPulled(false);
    try {
      const { metaAdSpendSync } = await sync.mutateAsync({});
      const error = metaAdSpendSync.userErrors[0];
      if (error) setProblem(userErrorText(error, t));
      // A pull that failed says why in the account's last error, above.
      else setPulled(!metaAdSpendSync.metaAdAccount?.lastError);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        className="self-start"
        busy={sync.isPending}
        icon={<RefreshCw aria-hidden className="size-5" />}
        onClick={() => void onPull()}
      >
        {t('adSpend.metaAccount.pull')}
      </Button>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {pulled && <Alert tone="success">{t('adSpend.metaAccount.pulled')}</Alert>}
    </div>
  );
}

/** Disconnecting the ad account, once asked whether they mean it: the spend pulled stays. */
function Disconnect({ adAccountId }: { adAccountId: string }) {
  const { t } = useLocale();
  const remove = useAdminMutation<MetaAdAccountDisconnectData, Record<string, never>>(
    MetaAdAccountDisconnectMutation,
  );
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onDisconnect = async () => {
    setProblem(null);
    try {
      const { metaAdAccountDisconnect } = await remove.mutateAsync({});
      const error = metaAdAccountDisconnect.userErrors[0];
      if (error) setProblem(userErrorText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {asking ? (
        <Alert tone="warning">
          <p>{t('adSpend.metaAccount.disconnectAsk', { id: adAccountId })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={remove.isPending}
              onClick={() => void onDisconnect()}
            >
              {t('meta.disconnectSure')}
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              {t('meta.keep')}
            </Button>
          </div>
        </Alert>
      ) : (
        <Button
          variant="danger"
          className="self-start"
          icon={<Link2Off aria-hidden className="size-5" />}
          onClick={() => setAsking(true)}
        >
          {t('adSpend.metaAccount.disconnect')}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/**
 * The shop's Meta ad account (ADR-564, ADR-565), whose spend Hatti pulls by day and campaign
 * every few hours: connected, pulled now, given another account or token, and disconnected.
 */
export function MetaAdAccountSection() {
  const { t } = useLocale();
  const query = useAdminQuery<MetaAdAccountData>(['metaAdAccount'], MetaAdAccountQuery);
  const [changing, setChanging] = useState(false);
  const current = query.data?.metaAdAccount ?? null;

  return (
    <FormSection title={t('adSpend.metaAccount.title')} hint={t('adSpend.metaAccount.hint')}>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : current ? (
        <>
          <Connected account={current} />
          <PullNow />
          {changing ? (
            <>
              <ConnectForm current={current} onConnected={() => setChanging(false)} />
              <Button
                variant="tertiary"
                className="self-start"
                icon={<X aria-hidden className="size-5" />}
                onClick={() => setChanging(false)}
              >
                {t('adSpend.metaAccount.cancel')}
              </Button>
            </>
          ) : (
            <Button
              variant="tertiary"
              className="self-start"
              icon={<Pencil aria-hidden className="size-5" />}
              onClick={() => setChanging(true)}
            >
              {t('adSpend.metaAccount.change')}
            </Button>
          )}
          <Disconnect adAccountId={current.adAccountId} />
        </>
      ) : (
        <>
          <p className="font-medium">{t('meta.notConnected')}</p>
          <ConnectForm current={null} onConnected={() => setChanging(false)} />
        </>
      )}
    </FormSection>
  );
}
