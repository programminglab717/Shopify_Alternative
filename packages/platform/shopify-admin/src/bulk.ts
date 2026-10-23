import type { ShopifyAdmin, ShopifyResult } from './admin.js';

const RUN = `mutation RunBulkQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const POLL = `query BulkOperation($id: ID!) {
  node(id: $id) { ... on BulkOperation { id status errorCode objectCount url } }
}`;

const CANCEL = `mutation CancelBulkOperation($id: ID!) {
  bulkOperationCancel(id: $id) { userErrors { message } }
}`;

interface BulkOperation {
  id: string;
  status: string;
  errorCode?: string | null;
  objectCount?: string | null;
  url?: string | null;
}

export interface BulkQueryOptions {
  /** How long to wait for Shopify to write the file; 90 seconds unless given. */
  waitMs?: number;
  /** How often to ask whether it has; two seconds unless given. */
  pollMs?: number;
  /** Waits, which a test's clock passes at once. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A query over all of a store's data, run by Shopify as a bulk operation, which no limit of a
 * query's cost holds back: Shopify writes what it finds to a file of JSON lines, each object on
 * its own line and each nested one naming its parent's ID in `__parentId`. Waited for, then read;
 * cancelled where it takes longer than Hatti waits.
 */
export async function runBulkQuery(
  admin: ShopifyAdmin,
  query: string,
  options: BulkQueryOptions = {},
): Promise<ShopifyResult<string>> {
  const waitMs = options.waitMs ?? 90_000;
  const pollMs = options.pollMs ?? 2_000;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const run = await admin.graphql<{
    bulkOperationRunQuery: {
      bulkOperation: BulkOperation | null;
      userErrors: { message: string }[];
    };
  }>(RUN, { query });
  if (!run.ok) return run;
  const { bulkOperation, userErrors } = run.value.bulkOperationRunQuery;
  if (!bulkOperation) {
    const message = userErrors[0]?.message ?? 'Shopify did not start the export';
    return {
      ok: false,
      kind: /in progress|already/i.test(message) ? 'busy' : 'other',
      message: /in progress|already/i.test(message)
        ? 'Shopify is still exporting this store for its app: try again in a few minutes'
        : `Shopify said: ${message}`.slice(0, 300),
    };
  }

  for (let waited = 0; ; waited += pollMs) {
    const poll = await admin.graphql<{ node: BulkOperation | null }>(POLL, {
      id: bulkOperation.id,
    });
    if (!poll.ok) return poll;
    const operation = poll.value.node;
    if (!operation) return { ok: false, kind: 'other', message: 'Shopify lost the export' };
    switch (operation.status) {
      case 'COMPLETED':
        // No file where the store has nothing to give.
        return operation.url ? admin.download(operation.url) : { ok: true, value: '' };
      case 'FAILED':
        return operation.errorCode === 'ACCESS_DENIED'
          ? {
              ok: false,
              kind: 'scope',
              message:
                "The store's app may not read this: give it the read_products and " +
                'read_inventory access scopes',
            }
          : {
              ok: false,
              kind: operation.errorCode === 'INTERNAL_SERVER_ERROR' ? 'busy' : 'other',
              message: `Shopify's export failed (${operation.errorCode ?? 'no reason given'})`,
            };
      case 'CANCELED':
      case 'CANCELING':
      case 'EXPIRED':
        return { ok: false, kind: 'other', message: "Shopify's export was stopped" };
    }
    if (waited >= waitMs) {
      await admin.graphql(CANCEL, { id: bulkOperation.id });
      return {
        ok: false,
        kind: 'busy',
        message: "Shopify is taking long to export the store's products: try again",
      };
    }
    await sleep(pollMs);
  }
}

/** The objects of a bulk query's file, in its order. */
export function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
