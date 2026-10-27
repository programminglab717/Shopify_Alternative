import { describe, expect, it } from 'vitest';
import { stitchedShipsOn } from './stitched.js';

describe("A stitched line's day to ship by (CAT-09, ADR-803)", () => {
  const offer = { price: 1_500_00, leadDays: 7, measurements: ['chest' as const] };

  it("counts the stitching's days from the day it was sold in Pakistan, or its pre-order's if later", () => {
    // 20:00 UTC on the 26th is the 27th in Pakistan.
    expect(stitchedShipsOn(new Date('2026-10-26T20:00:00Z'), offer, null)).toBe('2026-11-03');
    expect(stitchedShipsOn(new Date('2026-10-26T10:00:00Z'), offer, null)).toBe('2026-11-02');
    expect(stitchedShipsOn(new Date('2026-10-26T10:00:00Z'), offer, '2026-11-10')).toBe(
      '2026-11-17',
    );
    expect(stitchedShipsOn(new Date('2026-10-26T10:00:00Z'), offer, '2026-10-01')).toBe(
      '2026-11-02',
    );
    expect(stitchedShipsOn(new Date('2026-10-26T10:00:00Z'), undefined, null)).toBeNull();
  });
});
