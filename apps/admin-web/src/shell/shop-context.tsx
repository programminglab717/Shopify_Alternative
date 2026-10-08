import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { ShopQuery } from '../api/operations';
import { useSessionStore } from '../auth/context';
import type { ShopAccess } from '../auth/session';

const ShopContext = createContext<ShopAccess | null>(null);

export const ShopProvider = ShopContext.Provider;

/** The shop the admin is open on, and the signed-in member's role there. */
export function useShop(): ShopAccess {
  const shop = useContext(ShopContext);
  if (!shop) throw new Error('useShop must be used inside the shop shell');
  return shop;
}

/** A GraphQL query to the Admin API for the open shop, cached by shop and `key`. */
export function useAdminQuery<T>(
  key: readonly unknown[],
  document: string,
  variables?: Record<string, unknown>,
  options: { enabled?: boolean } = {},
) {
  const store = useSessionStore();
  const shop = useShop();
  return useQuery({
    queryKey: ['admin', shop.id, ...key, variables ?? null],
    queryFn: () => store.graphql<T>(shop.id, document, variables),
    enabled: options.enabled ?? true,
  });
}

/**
 * A GraphQL mutation to the Admin API for the open shop: the shop's cached queries are fetched
 * again once it is done, whatever it changed.
 */
export function useAdminMutation<T, V extends Record<string, unknown>>(document: string) {
  const store = useSessionStore();
  const shop = useShop();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: V) =>
      store.graphql<T>(shop.id, document, variables, { idempotencyKey: crypto.randomUUID() }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', shop.id] }),
  });
}

interface ShopDetails {
  shop: { id: string; name: string; handle: string; currencyCode: string; timezone: string };
}

/** The open shop's details, its time zone above all, which dates are shown in. */
export function useShopDetails(): ShopDetails['shop'] | undefined {
  return useAdminQuery<ShopDetails>(['shop'], ShopQuery).data?.shop;
}

/** The time zone the shop's dates are shown in: Pakistan's until the shop's is known. */
export function useShopTimezone(): string {
  return useShopDetails()?.timezone ?? 'Asia/Karachi';
}
