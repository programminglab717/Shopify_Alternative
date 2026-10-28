import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  formatRate,
  isPresentmentCurrency,
  parseRate,
  presentFromRupees,
  rateFromUnitsPerRupee,
} from './index.js';

describe("Prices in a shopper's currency (OS-21, ADR-865)", () => {
  it('takes rates as merchants write them, in rupees for one unit, and reads them back', () => {
    expect(parseRate('76.4521')).toBe(764_521n);
    expect(parseRate(' 280 ')).toBe(2_800_000n);
    expect(parseRate('0.5')).toBe(5_000n);
    for (const wrong of ['', '0', '0.0000', '76.45219', '-76', '1e3', '100000.0001', 'Rs 76']) {
      expect(parseRate(wrong)).toBeNull();
    }
    expect(formatRate(764_521n)).toBe('76.4521');
    expect(formatRate(2_800_000n)).toBe('280');
    expect(formatRate(765_000n)).toBe('76.5');
    // A feed's units for one rupee, as the open currency feed gives them.
    expect(rateFromUnitsPerRupee(0.013_08)).toBe(764_526n);
    expect(rateFromUnitsPerRupee(0)).toBeNull();
    expect(rateFromUnitsPerRupee(Number.NaN)).toBeNull();
    expect(isPresentmentCurrency('AED')).toBe(true);
    expect(isPresentmentCurrency('PKR')).toBe(false);
  });

  it('converts a price exactly, then rounds it as the shop asks, never a price to nothing', () => {
    // Rs 12,500 at 1 AED = Rs 76.4521.
    const aed = (rounding?: 'exact' | 'whole' | 'ninety_nine') =>
      formatMoney(presentFromRupees(1_250_000n, 'AED', 764_521n, rounding));
    expect(aed()).toBe('AED 163.50');
    expect(aed('whole')).toBe('AED 164');
    expect(aed('ninety_nine')).toBe('AED 163.99');
    // Rs 1,899 at 1 GBP = Rs 372.
    expect(formatMoney(presentFromRupees(189_900n, 'GBP', 3_720_000n))).toBe('£ 5.10');
    expect(formatMoney(presentFromRupees(189_900n, 'GBP', 3_720_000n, 'ninety_nine'))).toBe(
      '£ 5.99',
    );
    // A whole unit already .99 stays; a round one goes up to the next.
    expect(presentFromRupees(1_639_900n, 'USD', 1_000_000n, 'ninety_nine').amount).toBe(16_399n);
    expect(presentFromRupees(1_640_000n, 'USD', 1_000_000n, 'ninety_nine').amount).toBe(16_499n);
    expect(presentFromRupees(1_000n, 'USD', 2_800_000n, 'whole').amount).toBe(100n);
    expect(presentFromRupees(0n, 'USD', 2_800_000n, 'ninety_nine').amount).toBe(0n);
    expect(presentFromRupees(-1_250_000n, 'AED', 764_521n, 'whole').amount).toBe(-16_400n);
  });
});
