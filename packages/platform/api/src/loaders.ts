import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import DataLoader from 'dataloader';
import type { ApiContext } from './auth.js';

/** Keys per batch; beyond this a batch is split. Queries take the keys as one array parameter. */
const MAX_BATCH_SIZE = 1_000;

/**
 * Batch loaders for one GraphQL request. A field resolved for every item of a list, such as the
 * stock of each variant of each product on a page, asks a loader. The loader gathers the keys
 * asked for while the list resolves and fetches them with one query, instead of one per item.
 */
export class RequestLoaders {
  readonly #loaders = new Map<string, DataLoader<unknown, unknown>>();

  /**
   * The loader called `name`, created with `batch` on first use in the request. `batch` gets
   * distinct keys and returns what it found; keys it leaves out load as undefined.
   */
  get<K, V>(
    name: string,
    batch: (keys: readonly K[]) => Promise<ReadonlyMap<K, V>>,
  ): DataLoader<K, V | undefined> {
    let loader = this.#loaders.get(name) as DataLoader<K, V | undefined> | undefined;
    if (!loader) {
      loader = new DataLoader<K, V | undefined>(
        async (keys) => {
          const found = await batch(keys);
          return keys.map((key) => found.get(key));
        },
        { maxBatchSize: MAX_BATCH_SIZE },
      );
      this.#loaders.set(name, loader as DataLoader<unknown, unknown>);
    }
    return loader;
  }
}

/** The request's {@link RequestLoaders}, for resolvers. */
export const Loaders = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const graphqlContext = GqlExecutionContext.create(context).getContext<ApiContext>();
  graphqlContext.loaders ??= new RequestLoaders();
  return graphqlContext.loaders;
});
