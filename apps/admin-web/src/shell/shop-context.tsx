import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { ApiError } from '../api/client';
import { ShopQuery } from '../api/operations';
import { useSessionStore } from '../auth/context';
import type { ShopAccess } from '../auth/session';
import { QUEUEABLE, QUEUED, enqueue, isUnreachable, operationOf } from '../offline/outbox';

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
  options: {
    enabled?: boolean;
    refetchInterval?: (data: T | undefined) => number | false;
    /** Shows what the variables before fetched while new ones are fetched, as for "Show more". */
    keepPrevious?: boolean;
  } = {},
) {
  const store = useSessionStore();
  const shop = useShop();
  const { refetchInterval } = options;
  return useQuery<T>({
    queryKey: ['admin', shop.id, ...key, variables ?? null],
    queryFn: () => store.graphql<T>(shop.id, document, variables),
    enabled: options.enabled ?? true,
    refetchInterval: refetchInterval ? (query) => refetchInterval(query.state.data) : undefined,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
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
  const operation = operationOf(document);
  return useMutation({
    mutationFn: async (variables: V) => {
      const idempotencyKey = crypto.randomUUID();
      try {
        return await store.graphql<T>(shop.id, document, variables, { idempotencyKey });
      } catch (error) {
        // Offline, the changes staff make most on a phone wait on it to be sent (ADR-840).
        if (!operation || !QUEUEABLE.has(operation) || !isUnreachable(error)) throw error;
        enqueue({ id: idempotencyKey, shopId: shop.id, operation, document, variables });
        throw new ApiError(0, QUEUED, 'Saved on this phone, to send once it is back online');
      }
    },
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
