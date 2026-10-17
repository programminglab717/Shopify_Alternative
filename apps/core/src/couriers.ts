import {
  Couriers,
  LeopardsCourier,
  PostExCourier,
  TcsCourier,
  TestCourier,
  TraxCourier,
} from '@hatti/logistics/public';

/**
 * The couriers shops book with here (ADR-149, ADR-162, ADR-509, ADR-510): Leopards, PostEx, TCS and Trax, each at its own API
 * unless given another; and, outside production, the test courier, which books nothing.
 */
export function couriersOf(options: {
  production: boolean;
  postexUrl?: string;
  leopardsUrl?: string;
  tcsUrl?: string;
  traxUrl?: string;
}): Couriers {
  return new Couriers([
    new LeopardsCourier({ baseUrl: options.leopardsUrl }),
    new PostExCourier({ baseUrl: options.postexUrl }),
    new TcsCourier({ baseUrl: options.tcsUrl }),
    new TraxCourier({ baseUrl: options.traxUrl }),
    ...(options.production ? [] : [new TestCourier()]),
  ]);
}
