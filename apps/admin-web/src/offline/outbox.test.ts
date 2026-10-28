import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { enqueue, forgetAll, operationOf, queued, sendQueued, type QueuedChange } from './outbox';

const change = (id: string, operation = 'OrderConfirm') => ({
  id,
  shopId: 'shop_1',
  operation,
  document: `mutation ${operation}($id: ID!) { x }`,
  variables: { id: `ord_${id}` },
});

describe('Changes saved on the phone while offline (APP-05, ADR-840)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('names the operation a document runs', () => {
    expect(operationOf('mutation OrderConfirm($id: ID!) { orderConfirm(id: $id) { x } }')).toBe(
      'OrderConfirm',
    );
    expect(operationOf('query Orders { orders { x } }')).toBeNull();
  });

  it('sends what waits in order, keeping those refused with why, and stopping while offline', async () => {
    enqueue(change('1'), 1);
    enqueue(change('2'), 2);
    enqueue(change('3'), 3);
    enqueue(change('4'), 4);
    const sent: string[] = [];
    let offline = false;
    const send = (each: QueuedChange) => {
      sent.push(each.id);
      if (offline) return Promise.reject(new ApiError(0, 'NETWORK', 'down'));
      if (each.id === '2') {
        return Promise.resolve({
          orderConfirm: { userErrors: [{ message: 'Cancelled already' }] },
        });
      }
      if (each.id === '3') {
        offline = true;
        return Promise.reject(new ApiError(403, 'ACCESS_DENIED', 'No access'));
      }
      return Promise.resolve({ orderConfirm: { userErrors: [] } });
    };
    expect(await sendQueued(send, (error) => (error as Error).message)).toBe(1);
    // 1 sent; 2 refused by the core; 3 refused by the API; 4 waits for the network.
    expect(sent).toEqual(['1', '2', '3', '4']);
    expect(queued().map((each) => [each.id, each.refused ?? null])).toEqual([
      ['2', 'Cancelled already'],
      ['3', 'No access'],
      ['4', null],
    ]);
    // Those refused are not sent again; what waited goes once the network is back.
    offline = false;
    expect(await sendQueued(send, String)).toBe(1);
    expect(sent.slice(4)).toEqual(['4']);
    forgetAll();
    expect(queued()).toEqual([]);
  });
});
