import { describe, expect, it } from 'vitest';
import { chooseDiscounts, NO_DISCOUNTS } from './combining.js';
import { automaticSummary } from './discounts.js';
import type { AutomaticDiscountRecord, DiscountCodeRecord } from './records.js';

const AT = new Date('2026-10-17T12:00:00+05:00');
const SINCE = new Date('2026-10-01T00:00:00+05:00');

function automatic(
  id: string,
  given: Partial<AutomaticDiscountRecord> & Pick<AutomaticDiscountRecord, 'kind'>,
): AutomaticDiscountRecord {
  return {
    id,
    title: id,
    percentageBps: null,
    amount: null,
    minimumSubtotal: null,
    startsAt: SINCE,
    endsAt: null,
    combinesWithCodes: false,
    version: 1,
    createdAt: SINCE,
    updatedAt: SINCE,
    ...given,
  };
}

function code(given: Partial<DiscountCodeRecord> & Pick<DiscountCodeRecord, 'kind'>) {
  return {
    id: 'code',
    code: 'EID',
    title: 'EID',
    percentageBps: null,
    amount: null,
    minimumSubtotal: null,
    startsAt: SINCE,
    endsAt: null,
    usageLimit: null,
    oncePerCustomer: false,
    used: 0,
    version: 1,
    createdAt: SINCE,
    updatedAt: SINCE,
    ...given,
  } satisfies DiscountCodeRecord;
}

describe('Choosing the discounts an order takes (ADR-515)', () => {
  it('applies the automatic discount that takes most off the items, with free delivery beside it', () => {
    const tenth = automatic('tenth', { kind: 'percentage', percentageBps: 1_000 });
    const fiveHundred = automatic('rs500', { kind: 'fixed_amount', amount: 50_000n });
    const delivery = automatic('delivery', { kind: 'free_shipping' });
    const big = automatic('big', {
      kind: 'percentage',
      percentageBps: 2_000,
      minimumSubtotal: 1_000_000n,
    });
    const ended = automatic('ended', {
      kind: 'percentage',
      percentageBps: 5_000,
      endsAt: new Date('2026-10-10T00:00:00+05:00'),
    });
    const ahead = automatic('ahead', {
      kind: 'percentage',
      percentageBps: 5_000,
      startsAt: new Date('2026-11-01T00:00:00+05:00'),
    });
    const all = [tenth, fiveHundred, delivery, big, ended, ahead];

    // Rs 3,000 of items: Rs 500 beats 10% (Rs 300); the 20% needs Rs 10,000.
    const small = chooseDiscounts(300_000n, null, all, AT);
    expect(small.automatic.map((discount) => discount.id)).toEqual(['rs500', 'delivery']);
    expect(small).toMatchObject({ items: 50_000n, byAutomatic: 50_000n, freeDelivery: true });

    // Rs 10,000: 20% (Rs 2,000).
    const large = chooseDiscounts(1_000_000n, null, all, AT);
    expect(large.automatic.map((discount) => discount.id)).toEqual(['big', 'delivery']);
    expect(large.items).toBe(200_000n);

    expect(chooseDiscounts(300_000n, null, [ended, ahead], AT)).toEqual(NO_DISCOUNTS);
    // Never more than the items come to.
    expect(chooseDiscounts(20_000n, null, [fiveHundred], AT).items).toBe(20_000n);
  });

  it('adds a code where every automatic discount applied combines with codes', () => {
    const tenth = automatic('tenth', {
      kind: 'percentage',
      percentageBps: 1_000,
      combinesWithCodes: true,
    });
    const chosen = chooseDiscounts(
      300_000n,
      code({ kind: 'fixed_amount', amount: 20_000n }),
      [tenth],
      AT,
    );
    expect(chosen).toMatchObject({
      code: { id: 'code' },
      setAside: null,
      items: 50_000n,
      byCode: 20_000n,
      byAutomatic: 30_000n,
      freeDelivery: false,
    });
    expect(chosen.automatic).toHaveLength(1);

    // Together they take no more than the items.
    const capped = chooseDiscounts(
      30_000n,
      code({ kind: 'fixed_amount', amount: 28_000n }),
      [tenth],
      AT,
    );
    expect(capped).toMatchObject({ items: 30_000n, byCode: 28_000n, byAutomatic: 2_000n });
  });

  it("keeps whichever takes more off the items where one doesn't combine, the code on a tie", () => {
    const tenth = automatic('tenth', { kind: 'percentage', percentageBps: 1_000 });
    const delivery = automatic('delivery', { kind: 'free_shipping', combinesWithCodes: true });

    // 10% (Rs 300) beats a Rs 200 code: the code is set aside.
    const automaticWins = chooseDiscounts(
      300_000n,
      code({ kind: 'fixed_amount', amount: 20_000n }),
      [tenth, delivery],
      AT,
    );
    expect(automaticWins).toMatchObject({
      code: null,
      setAside: { id: 'code' },
      items: 30_000n,
      byCode: 0n,
      freeDelivery: true,
    });

    // A Rs 500 code beats it: the automatic discounts go, free delivery with them.
    const codeWins = chooseDiscounts(
      300_000n,
      code({ kind: 'fixed_amount', amount: 50_000n }),
      [tenth, delivery],
      AT,
    );
    expect(codeWins).toMatchObject({
      code: { id: 'code' },
      setAside: null,
      automatic: [],
      items: 50_000n,
      freeDelivery: false,
    });

    // Free delivery alone, and a free-delivery code: equal off the items, so the code.
    const tie = chooseDiscounts(
      300_000n,
      code({ kind: 'free_shipping' }),
      [automatic('delivery', { kind: 'free_shipping' })],
      AT,
    );
    expect(tie).toMatchObject({ code: { id: 'code' }, automatic: [], freeDelivery: true });
  });

  it('says what an automatic discount gives in a line', () => {
    expect(
      automaticSummary(
        automatic('eid', {
          kind: 'percentage',
          percentageBps: 1_000,
          minimumSubtotal: 300_000n,
          combinesWithCodes: true,
        }),
        'PKR',
      ),
    ).toBe('10% off orders of Rs 3,000 or more; with codes');
    expect(automaticSummary(automatic('d', { kind: 'free_shipping' }), 'PKR')).toBe(
      'Free delivery',
    );
  });
});
