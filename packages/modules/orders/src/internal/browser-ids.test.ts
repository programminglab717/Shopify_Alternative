import { describe, expect, it } from 'vitest';
import { browserIdsOf } from './browser-ids.js';

describe("An order's browser IDs (ADR-144, ADR-551)", () => {
  it('keeps those in their format, and a declined consent alone', () => {
    expect(
      browserIdsOf({ fbp: 'fb.1.1727856000000.1116446470', ga: 'GA1.1.x', ttp: 42, other: 'x' }),
    ).toEqual({ fbp: 'fb.1.1727856000000.1116446470' });
    expect(browserIdsOf({ ga: 'GA1.1.' + '9'.repeat(30) })).toBeNull();
    expect(browserIdsOf(null)).toBeNull();
    // Declined, the order names no browser, whatever came with it.
    expect(browserIdsOf({ consent: 'denied', fbp: 'fb.1.1727856000000.1116446470' })).toEqual({
      consent: 'denied',
    });
    expect(browserIdsOf({ consent: 'granted' })).toBeNull();
  });
});
