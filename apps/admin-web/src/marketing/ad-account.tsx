import { Link2, Link2Off, Pencil, RefreshCw, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { UserError } from '../api/types';
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

/** An ad platform's account as the card shows it, whichever platform it is. */
export interface AdAccountView {
  /** Its ID, as the platform's ads manager shows it. */
  id: string;
  name: string;
  currency: string;
  accessTokenHint: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/** What connecting the account, or pulling its spend, answered. */
export interface AdAccountAnswer {
  account: AdAccountView | null;
  userErrors: UserError[];
}

/**
 * An ad platform whose spend Hatti pulls (ADR-565, ADR-567): its documents, how their answers
 * read, and its own words; the words all platforms share are the card's.
 */
export interface AdPlatform<Query, Connect, Sync, Disconnect> {
  /** The account query's key, under the shop's. */
  queryKey: string;
  query: string;
  connectMutation: string;
  syncMutation: string;
  disconnectMutation: string;
  /** Its ID's field, as the connect input and its problems name it. */
  idField: string;
  account: (data: Query) => AdAccountView | null;
  connected: (data: Connect) => AdAccountAnswer;
  synced: (data: Sync) => AdAccountAnswer;
  disconnected: (data: Disconnect) => UserError[];
  text: {
    title: MessageKey;
    hint: MessageKey;
    id: MessageKey;
    idHint: MessageKey;
    tokenHint: MessageKey;
    /** The account's name, in its details. */
    name: MessageKey;
    lastError: MessageKey;
    pulled: MessageKey;
    disconnect: MessageKey;
    /** Asked before disconnecting the account {id}. */
    disconnectAsk: MessageKey;
    /**
     * The button the connect form waits behind until asked for, while no account is connected:
     * without one, the form shows at once.
     */
    open?: MessageKey;
  };
}

type Field = 'id' | 'accessToken';

/**
 * Connecting the shop's account, or another in its place, or a new token for it: its ID, and a
 * token, sealed and never shown again, sent once the member confirms who they are. A problem with
 * a field shows under it; any other, the plan's among them, above the button.
 */
function ConnectForm<Q, C, S, D>({
  platform,
  current,
  onConnected,
}: {
  platform: AdPlatform<Q, C, S, D>;
  current: AdAccountView | null;
  onConnected: () => void;
}) {
  const { t } = useLocale();
  const connect = useAdminMutation<C, { input: Record<string, string> }>(platform.connectMutation);
  const { run, panel } = useRecentAuthentication();
  const [id, setId] = useState(current?.id ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const ready = id.trim() !== '' && accessToken.trim() !== '';
  // The form's fields, as the API names them in its problems.
  const fields = new Map<string, Field>([
    [platform.idField, 'id'],
    ['accessToken', 'accessToken'],
  ]);
  const labels: Partial<Record<string, MessageKey>> = {
    [platform.idField]: platform.text.id,
    accessToken: 'meta.accessToken',
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setErrors({});
    setProblems([]);
    void run(
      async () => {
        const answer = platform.connected(
          await connect.mutateAsync({
            input: { [platform.idField]: id.trim(), accessToken: accessToken.trim() },
          }),
        );
        if (answer.userErrors.length > 0 || !answer.account) {
          const under: Partial<Record<Field, string>> = {};
          const general: string[] = [];
          for (const error of answer.userErrors) {
            const field = error.field ?? [];
            const named =
              field.length === 2 && field[0] === 'input' ? fields.get(field[1]!) : undefined;
            if (named) under[named] = userErrorText(error, t);
            else general.push(settingProblem(error, t, labels));
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
        label={t(platform.text.id)}
        hint={t(platform.text.idHint)}
        autoComplete="off"
        ltr
        required
        className="max-w-xs"
        value={id}
        error={errors.id}
        onChange={(event) => setId(event.target.value)}
      />
      <TextField
        label={t(current ? 'meta.newAccessToken' : 'meta.accessToken')}
        hint={t(platform.text.tokenHint)}
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
        {t('adSpend.account.connect')}
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
 * The connected account: its name, ID and currency, its token as its last four characters, when
 * its spend was last pulled and why that failed, if it did.
 */
function Connected<Q, C, S, D>({
  platform,
  account,
}: {
  platform: AdPlatform<Q, C, S, D>;
  account: AdAccountView;
}) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const rows: { label: MessageKey; value: string; ltr: boolean }[] = [
    { label: platform.text.name, value: account.name, ltr: false },
    { label: platform.text.id, value: account.id, ltr: true },
    { label: 'adSpend.account.currency', value: account.currency, ltr: true },
    { label: 'meta.accessToken', value: `•••• ${account.accessTokenHint}`, ltr: true },
    {
      label: 'adSpend.account.lastPulled',
      value: account.lastSyncedAt
        ? formatDateTime(account.lastSyncedAt, timezone, locale)
        : t('adSpend.account.notPulled'),
      ltr: false,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="success">{t('adSpend.account.connected', { name: account.name })}</Alert>
      {account.lastError && (
        <Alert tone="warning">
          <p>{t(platform.text.lastError)}</p>
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
function PullNow<Q, C, S, D>({ platform }: { platform: AdPlatform<Q, C, S, D> }) {
  const { t } = useLocale();
  const sync = useAdminMutation<S, Record<string, never>>(platform.syncMutation);
  const [problem, setProblem] = useState<string | null>(null);
  const [pulled, setPulled] = useState(false);

  const onPull = async () => {
    setProblem(null);
    setPulled(false);
    try {
      const answer = platform.synced(await sync.mutateAsync({}));
      const error = answer.userErrors[0];
      if (error) setProblem(userErrorText(error, t));
      // A pull that failed says why in the account's last error, above.
      else setPulled(!answer.account?.lastError);
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
        {t('adSpend.account.pull')}
      </Button>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {pulled && <Alert tone="success">{t(platform.text.pulled)}</Alert>}
    </div>
  );
}

/** Disconnecting the account, once asked whether they mean it: the spend pulled stays. */
function Disconnect<Q, C, S, D>({
  platform,
  id,
}: {
  platform: AdPlatform<Q, C, S, D>;
  id: string;
}) {
  const { t } = useLocale();
  const remove = useAdminMutation<D, Record<string, never>>(platform.disconnectMutation);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const onDisconnect = async () => {
    setProblem(null);
    try {
      const error = platform.disconnected(await remove.mutateAsync({}))[0];
      if (error) setProblem(userErrorText(error, t));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {asking ? (
        <Alert tone="warning">
          <p>{t(platform.text.disconnectAsk, { id })}</p>
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
          {t(platform.text.disconnect)}
        </Button>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}

/**
 * No account connected: the connect form, or, for a platform whose form waits until asked for, a
 * button that shows it, so that a card not in use stays short on a phone.
 */
function NotConnected<Q, C, S, D>({
  platform,
  onConnected,
}: {
  platform: AdPlatform<Q, C, S, D>;
  onConnected: () => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const formId = useId();

  if (!platform.text.open) {
    return (
      <>
        <p className="font-medium">{t('meta.notConnected')}</p>
        <ConnectForm platform={platform} current={null} onConnected={onConnected} />
      </>
    );
  }
  return (
    <>
      <Button
        variant="secondary"
        className="self-start"
        aria-expanded={open}
        aria-controls={formId}
        icon={<Link2 aria-hidden className="size-5" />}
        onClick={() => setOpen(!open)}
      >
        {t(platform.text.open)}
      </Button>
      <div id={formId} className="flex flex-col gap-4">
        {open && <ConnectForm platform={platform} current={null} onConnected={onConnected} />}
      </div>
    </>
  );
}

/**
 * The shop's account on an ad platform, whose spend Hatti pulls by day and campaign every few
 * hours: connected, pulled now, given another account or token, and disconnected.
 */
export function AdAccountSection<Q, C, S, D>({ platform }: { platform: AdPlatform<Q, C, S, D> }) {
  const { t } = useLocale();
  const query = useAdminQuery<Q>([platform.queryKey], platform.query);
  const [changing, setChanging] = useState(false);
  const current = query.data === undefined ? null : platform.account(query.data);

  return (
    <FormSection title={t(platform.text.title)} hint={t(platform.text.hint)}>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      ) : current ? (
        <>
          <Connected platform={platform} account={current} />
          <PullNow platform={platform} />
          {changing ? (
            <>
              <ConnectForm
                platform={platform}
                current={current}
                onConnected={() => setChanging(false)}
              />
              <Button
                variant="tertiary"
                className="self-start"
                icon={<X aria-hidden className="size-5" />}
                onClick={() => setChanging(false)}
              >
                {t('adSpend.account.cancel')}
              </Button>
            </>
          ) : (
            <Button
              variant="tertiary"
              className="self-start"
              icon={<Pencil aria-hidden className="size-5" />}
              onClick={() => setChanging(true)}
            >
              {t('adSpend.account.change')}
            </Button>
          )}
          <Disconnect platform={platform} id={current.id} />
        </>
      ) : (
        <NotConnected platform={platform} onConnected={() => setChanging(false)} />
      )}
    </FormSection>
  );
}
