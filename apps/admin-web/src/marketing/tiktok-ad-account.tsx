import {
  TikTokAdAccountConnectMutation,
  TikTokAdAccountDisconnectMutation,
  TikTokAdAccountQuery,
  TikTokAdSpendSyncMutation,
} from '../api/operations';
import type {
  TikTokAdAccount,
  TikTokAdAccountConnectData,
  TikTokAdAccountData,
  TikTokAdAccountDisconnectData,
  TikTokAdSpendSyncData,
} from '../api/types';
import { AdAccountSection } from './ad-account';
import type { AdAccountView, AdPlatform } from './ad-account';

const view = (account: TikTokAdAccount | null): AdAccountView | null =>
  account && { ...account, id: account.advertiserId };

/**
 * TikTok's advertiser account: its ID as TikTok Ads Manager shows it, and a long-term token of
 * its Marketing API. Its form waits behind a button until asked for, so that the page stays short
 * on a phone for the shops that don't advertise on TikTok.
 */
const TIKTOK: AdPlatform<
  TikTokAdAccountData,
  TikTokAdAccountConnectData,
  TikTokAdSpendSyncData,
  TikTokAdAccountDisconnectData
> = {
  queryKey: 'tiktokAdAccount',
  query: TikTokAdAccountQuery,
  connectMutation: TikTokAdAccountConnectMutation,
  syncMutation: TikTokAdSpendSyncMutation,
  disconnectMutation: TikTokAdAccountDisconnectMutation,
  idField: 'advertiserId',
  account: (data) => view(data.tiktokAdAccount),
  connected: ({ tiktokAdAccountConnect }) => ({
    account: view(tiktokAdAccountConnect.tiktokAdAccount),
    userErrors: tiktokAdAccountConnect.userErrors,
  }),
  synced: ({ tiktokAdSpendSync }) => ({
    account: view(tiktokAdSpendSync.tiktokAdAccount),
    userErrors: tiktokAdSpendSync.userErrors,
  }),
  disconnected: (data) => data.tiktokAdAccountDisconnect.userErrors,
  text: {
    title: 'adSpend.tiktokAccount.title',
    hint: 'adSpend.tiktokAccount.hint',
    id: 'adSpend.tiktokAccount.id',
    idHint: 'adSpend.tiktokAccount.idHint',
    tokenHint: 'adSpend.tiktokAccount.tokenHint',
    name: 'adSpend.tiktokAccount.name',
    lastError: 'adSpend.tiktokAccount.lastError',
    pulled: 'adSpend.tiktokAccount.pulled',
    disconnect: 'adSpend.tiktokAccount.disconnect',
    disconnectAsk: 'adSpend.tiktokAccount.disconnectAsk',
    open: 'adSpend.tiktokAccount.open',
  },
};

/**
 * The shop's TikTok advertiser account (ADR-566, ADR-567), whose spend Hatti pulls by day and
 * campaign every few hours: connected, pulled now, given another account or token, and
 * disconnected.
 */
export function TikTokAdAccountSection() {
  return <AdAccountSection platform={TIKTOK} />;
}
