import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  GoogleAdsAccountConnectMutation,
  GoogleAdsAccountDisconnectMutation,
  GoogleAdsAccountQuery,
  GoogleAdsConsentUrlQuery,
  GoogleAdsSpendSyncMutation,
} from '../api/operations';
import type {
  GoogleAdsAccount,
  GoogleAdsAccountConnectData,
  GoogleAdsAccountData,
  GoogleAdsAccountDisconnectData,
  GoogleAdsConsentUrlData,
  GoogleAdsSpendSyncData,
} from '../api/types';
import { useSessionStore } from '../auth/context';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText, userErrorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { Problems, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { AdAccountSection } from './ad-account';
import type { AdAccountView, AdPlatform, ConnectFormProps } from './ad-account';

/** Where Google's consent screen comes back to: one address for every shop, as Google asks. */
export const GOOGLE_ADS_RETURN_PATH = '/google-ads';

/** The connection on its way to Google and back, kept by the browser's tab meanwhile. */
const PENDING_KEY = 'hatti.googleAdsGrant';

/** A connection started here: the shop's, the account asked for, and what Google is to give back. */
export interface PendingGrant {
  state: string;
  shopId: string;
  customerId: string;
  redirectUri: string;
}

/** What Google's consent screen came back with, as the ad spend page and its return take it. */
export interface GrantSearch {
  code?: string;
  state?: string;
  error?: string;
}

/** Google's code, state and error from an address's query, ignoring anything else. */
export function validateGrantSearch(search: Record<string, unknown>): GrantSearch {
  // The router reads a query's values as JSON where they are: a state of digits is a number.
  const text = (value: unknown) =>
    typeof value === 'string' && value !== ''
      ? value
      : typeof value === 'number'
        ? `${value}`
        : undefined;
  const code = text(search.code);
  const state = text(search.state);
  const error = text(search.error);
  return { ...(code && { code }), ...(state && { state }), ...(error && { error }) };
}

/** The connection started in this tab, if it is the one `state` names. */
export function pendingGrant(state: string | undefined): PendingGrant | null {
  if (!state) return null;
  try {
    const pending = JSON.parse(
      window.sessionStorage.getItem(PENDING_KEY) ?? 'null',
    ) as PendingGrant | null;
    return pending?.state === state ? pending : null;
  } catch {
    return null;
  }
}

function keepPending(pending: PendingGrant | null) {
  try {
    if (pending) window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // A browser that keeps nothing for the tab cannot come back to the connection: it says so then.
  }
}

/** "123-456-7890", as Google Ads shows a customer ID. */
const shown = (id: string) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;

const view = (account: GoogleAdsAccount | null): AdAccountView | null =>
  account && { ...account, id: shown(account.customerId), accessTokenHint: account.grantHint };

/**
 * The account to connect, by its customer ID, then Google's consent screen, where its owner
 * grants Hatti the reading of their Google Ads accounts: Google comes back to the admin's one
 * return address, which brings the member back here to finish (ADR-679).
 */
function GoogleConnectForm({ current }: ConnectFormProps) {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const [customerId, setCustomerId] = useState(current?.id ?? '');
  const [error, setError] = useState<string | undefined>();
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setProblems([]);
    const digits = customerId.replace(/[\s-]/g, '');
    if (!/^\d{10}$/.test(digits)) {
      setError(t('adSpend.googleAccount.idInvalid'));
      return;
    }
    setBusy(true);
    try {
      const state = crypto.randomUUID();
      const redirectUri = `${window.location.origin}${GOOGLE_ADS_RETURN_PATH}`;
      const { googleAdsConsentUrl } = await store.graphql<GoogleAdsConsentUrlData>(
        shop.id,
        GoogleAdsConsentUrlQuery,
        { redirectUri, state },
      );
      if (!googleAdsConsentUrl) {
        setProblems([t('adSpend.googleAccount.unavailable')]);
        setBusy(false);
        return;
      }
      keepPending({ state, shopId: shop.id, customerId: shown(digits), redirectUri });
      window.location.assign(googleAdsConsentUrl);
    } catch (failure) {
      setProblems([errorText(failure, t)]);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <TextField
        label={t('adSpend.googleAccount.id')}
        hint={t('adSpend.googleAccount.idHint')}
        autoComplete="off"
        inputMode="numeric"
        ltr
        required
        className="max-w-xs"
        value={customerId}
        error={error}
        onChange={(event) => setCustomerId(event.target.value)}
      />
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('adSpend.googleAccount.consentHint')}
      </p>
      <Problems problems={problems} />
      <Button
        type="submit"
        className="self-start"
        busy={busy}
        disabled={customerId.trim() === ''}
        icon={<ExternalLink aria-hidden className="size-5" />}
      >
        {t('adSpend.googleAccount.continue')}
      </Button>
    </form>
  );
}

/** The fields of the connect input, as the API names them in its problems. */
const LABELS: Partial<Record<string, MessageKey>> = {
  customerId: 'adSpend.googleAccount.id',
  code: 'adSpend.googleAccount.grant',
};

/**
 * The member back from Google's consent screen: the account asked for is connected with the
 * code Google gave, once they confirm who they are if it was a while ago; or what went wrong.
 * The code leaves the page's address at once, as it is good once.
 */
function GrantReturn() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const search = useSearch({ from: '/$shopId/marketing/ad-spend' });
  const connect = useAdminMutation<GoogleAdsAccountConnectData, { input: Record<string, string> }>(
    GoogleAdsAccountConnectMutation,
  );
  const { run, panel } = useRecentAuthentication();
  const [problems, setProblems] = useState<string[]>([]);
  // Whether the page opened on Google's way back: the address loses what Google gave at once.
  const [returned] = useState(() => Boolean(search.state));
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !search.state) return;
    started.current = true;
    const pending = pendingGrant(search.state);
    keepPending(null);
    void navigate({
      to: '/$shopId/marketing/ad-spend',
      params: { shopId: shop.id },
      search: {},
      replace: true,
    });
    if (!pending || pending.shopId !== shop.id) {
      setProblems([t('adSpend.googleAccount.stale')]);
      return;
    }
    if (!search.code) {
      setProblems([
        t(
          search.error === 'access_denied'
            ? 'adSpend.googleAccount.denied'
            : 'adSpend.googleAccount.failed',
        ),
      ]);
      return;
    }
    const code = search.code;
    void run(
      async () => {
        const { googleAdsAccountConnect: answer } = await connect.mutateAsync({
          input: { customerId: pending.customerId, code, redirectUri: pending.redirectUri },
        });
        setProblems(
          answer.userErrors.map((error) =>
            error.field?.length === 2 ? settingProblem(error, t, LABELS) : userErrorText(error, t),
          ),
        );
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  }, [connect, navigate, run, search, shop.id, t]);

  if (!returned) return null;
  return (
    <>
      {connect.isPending && <Loading label={t('adSpend.googleAccount.connecting')} />}
      <Problems problems={problems} />
      {problems.length > 0 && (
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('adSpend.googleAccount.again')}
        </p>
      )}
      {panel}
    </>
  );
}

/**
 * Google Ads (ADR-678, ADR-679): the account by its customer ID, its owner's grant given on
 * Google's own screen. The form shows at once, being one field.
 */
const GOOGLE: AdPlatform<
  GoogleAdsAccountData,
  GoogleAdsAccountConnectData,
  GoogleAdsSpendSyncData,
  GoogleAdsAccountDisconnectData
> = {
  queryKey: 'googleAdsAccount',
  query: GoogleAdsAccountQuery,
  connectMutation: GoogleAdsAccountConnectMutation,
  syncMutation: GoogleAdsSpendSyncMutation,
  disconnectMutation: GoogleAdsAccountDisconnectMutation,
  idField: 'customerId',
  account: (data) => view(data.googleAdsAccount),
  connected: ({ googleAdsAccountConnect }) => ({
    account: view(googleAdsAccountConnect.googleAdsAccount),
    userErrors: googleAdsAccountConnect.userErrors,
  }),
  synced: ({ googleAdsSpendSync }) => ({
    account: view(googleAdsSpendSync.googleAdsAccount),
    userErrors: googleAdsSpendSync.userErrors,
  }),
  disconnected: (data) => data.googleAdsAccountDisconnect.userErrors,
  connectForm: GoogleConnectForm,
  text: {
    title: 'adSpend.googleAccount.title',
    hint: 'adSpend.googleAccount.hint',
    id: 'adSpend.googleAccount.id',
    idHint: 'adSpend.googleAccount.idHint',
    tokenHint: 'adSpend.googleAccount.consentHint',
    token: 'adSpend.googleAccount.grant',
    name: 'adSpend.googleAccount.name',
    lastError: 'adSpend.googleAccount.lastError',
    pulled: 'adSpend.googleAccount.pulled',
    disconnect: 'adSpend.googleAccount.disconnect',
    disconnectAsk: 'adSpend.googleAccount.disconnectAsk',
  },
};

/**
 * The shop's Google Ads account (ADR-678, ADR-679), whose spend Hatti pulls by day and campaign
 * every few hours: connected through Google's consent screen, pulled now, given another account
 * or grant, and disconnected.
 */
export function GoogleAdsAccountSection() {
  return (
    <AdAccountSection platform={GOOGLE}>
      <GrantReturn />
    </AdAccountSection>
  );
}

/**
 * Google's consent screen comes back here, the admin's one address for it: the member goes on to
 * the ad spend page of the shop that asked, to finish there, or hears that this tab started no
 * connection.
 */
export function GoogleAdsReturnPage() {
  const { t } = useLocale();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-4">
      <Alert tone="warning">{t('adSpend.googleAccount.stale')}</Alert>
      <Link to="/shops" className="underline">
        {t('adSpend.googleAccount.toShops')}
      </Link>
    </main>
  );
}
