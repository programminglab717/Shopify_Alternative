import { Couriers, LeopardsCourier, PostExCourier, TestCourier } from '@hatti/logistics/public';

/**
 * The couriers shops book with here (ADR-149, ADR-162): Leopards and PostEx, each at its own API
 * unless given another; and, outside production, the test courier, which books nothing.
 */
export function couriersOf(options: {
  production: boolean;
  postexUrl?: string;
  leopardsUrl?: string;
}): Couriers {
  return new Couriers([
    new LeopardsCourier({ baseUrl: options.leopardsUrl }),
    new PostExCourier({ baseUrl: options.postexUrl }),
    ...(options.production ? [] : [new TestCourier()]),
  ]);
}
