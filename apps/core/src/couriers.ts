import { Couriers, PostExCourier, TestCourier } from '@hatti/logistics/public';

/**
 * The couriers shops book with here (ADR-149): PostEx, at `postexUrl` unless its own; and, outside
 * production, the test courier, which books nothing.
 */
export function couriersOf(options: { production: boolean; postexUrl?: string }): Couriers {
  return new Couriers([
    new PostExCourier({ baseUrl: options.postexUrl }),
    ...(options.production ? [] : [new TestCourier()]),
  ]);
}
