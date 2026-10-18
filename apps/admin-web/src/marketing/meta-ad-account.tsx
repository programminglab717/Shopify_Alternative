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
import { AdAccountSection } from './ad-account';
import type { AdAccountView, AdPlatform } from './ad-account';

const view = (account: MetaAdAccount | null): AdAccountView | null =>
  account && { ...account, id: account.adAccountId };

/** Meta's ad account: its ID as Ads Manager shows it, and a token with ads_read on it. */
const META: AdPlatform<
  MetaAdAccountData,
  MetaAdAccountConnectData,
  MetaAdSpendSyncData,
  MetaAdAccountDisconnectData
> = {
  queryKey: 'metaAdAccount',
  query: MetaAdAccountQuery,
  connectMutation: MetaAdAccountConnectMutation,
  syncMutation: MetaAdSpendSyncMutation,
  disconnectMutation: MetaAdAccountDisconnectMutation,
  idField: 'adAccountId',
  account: (data) => view(data.metaAdAccount),
  connected: ({ metaAdAccountConnect }) => ({
    account: view(metaAdAccountConnect.metaAdAccount),
    userErrors: metaAdAccountConnect.userErrors,
  }),
  synced: ({ metaAdSpendSync }) => ({
    account: view(metaAdSpendSync.metaAdAccount),
    userErrors: metaAdSpendSync.userErrors,
  }),
  disconnected: (data) => data.metaAdAccountDisconnect.userErrors,
  text: {
    title: 'adSpend.metaAccount.title',
    hint: 'adSpend.metaAccount.hint',
    id: 'adSpend.metaAccount.id',
    idHint: 'adSpend.metaAccount.idHint',
    tokenHint: 'adSpend.metaAccount.tokenHint',
    name: 'adSpend.metaAccount.name',
    lastError: 'adSpend.metaAccount.lastError',
    pulled: 'adSpend.metaAccount.pulled',
    disconnect: 'adSpend.metaAccount.disconnect',
    disconnectAsk: 'adSpend.metaAccount.disconnectAsk',
  },
};

/**
 * The shop's Meta ad account (ADR-564, ADR-565), whose spend Hatti pulls by day and campaign
 * every few hours: connected, pulled now, given another account or token, and disconnected.
 */
export function MetaAdAccountSection() {
  return <AdAccountSection platform={META} />;
}
