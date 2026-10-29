import { describe, expect, it } from 'vitest';
import {
  guardrailTripped,
  revenueVerdictOf,
  revenueZScoreOf,
  verdictOf,
  zScoreOf,
  type ArmCounts,
} from './theme-experiments.js';

/** An arm whose `converted` sessions each placed an order of `order`, in paisa: Rs 5,000. */
const arm = (sessions: number, converted: number, order = 500_000): ArmCounts => ({
  sessions,
  added_to_cart: converted * 3,
  reached_checkout: converted * 2,
  converted,
  revenue: converted * order,
  revenue_squares: converted * order * order,
});

describe('What a theme experiment says of its draft (OS-22, ADR-866)', () => {
  it('waits for sessions enough, then tells better from worse at 95%, and the rest as no difference', () => {
    expect(verdictOf({ a: arm(150, 3), b: arm(150, 12) })).toBe('too_early');
    expect(zScoreOf({ a: arm(0, 0), b: arm(10, 1) })).toBeNull();
    // 2% against 4% of 1,000 sessions each: better, z ≈ 2.62.
    const better = { a: arm(1_000, 20), b: arm(1_000, 40) };
    expect(zScoreOf(better)).toBeCloseTo(2.62, 2);
    expect(verdictOf(better)).toBe('b_better');
    expect(verdictOf({ a: arm(1_000, 40), b: arm(1_000, 20) })).toBe('b_worse');
    expect(verdictOf({ a: arm(1_000, 20), b: arm(1_000, 24) })).toBe('no_difference');
  });

  it('ends one whose draft sells clearly worse, at 99.5% and 500 sessions each, never on a hunch', () => {
    expect(guardrailTripped({ a: arm(1_000, 40), b: arm(1_000, 15) })).toBe(true);
    // Worse at 95% but not at 99.5%.
    expect(guardrailTripped({ a: arm(1_000, 40), b: arm(1_000, 24) })).toBe(false);
    // Clearly worse, but too few sessions.
    expect(guardrailTripped({ a: arm(400, 40), b: arm(400, 4) })).toBe(false);
    expect(guardrailTripped({ a: arm(1_000, 15), b: arm(1_000, 40) })).toBe(false);
  });

  it('tells whether the draft brings more or less money a session, by Welch’s test (ADR-921)', () => {
    expect(revenueVerdictOf({ a: arm(150, 3), b: arm(150, 12) })).toBe('too_early');
    expect(revenueZScoreOf({ a: arm(1, 0), b: arm(10, 1) })).toBeNull();
    // Nobody ordered: no spread to tell by.
    expect(revenueZScoreOf({ a: arm(500, 0), b: arm(500, 0) })).toBeNull();
    // Twice the orders of the same size: more a session, z ≈ 2.62.
    expect(revenueZScoreOf({ a: arm(1_000, 20), b: arm(1_000, 40) })).toBeCloseTo(2.62, 2);
    // As many orders, three times the size: no different by orders, more by money.
    const larger = { a: arm(1_000, 20), b: arm(1_000, 20, 1_500_000) };
    expect(verdictOf(larger)).toBe('no_difference');
    expect(revenueZScoreOf(larger)).toBeCloseTo(2.86, 2);
    expect(revenueVerdictOf(larger)).toBe('b_better');
    expect(revenueVerdictOf({ a: arm(1_000, 20, 1_500_000), b: arm(1_000, 20) })).toBe('b_worse');
    expect(revenueVerdictOf({ a: arm(1_000, 20), b: arm(1_000, 22) })).toBe('no_difference');
  });

  it('asks more of each draft as there are more of them, so none is found better by chance (ADR-931)', () => {
    // 2% against 3.6% of 1,000 sessions each, z ≈ 2.17: better alone, not among two drafts.
    const one = { a: arm(1_000, 20), b: arm(1_000, 36) };
    expect(zScoreOf(one)).toBeCloseTo(2.17, 2);
    expect(verdictOf(one)).toBe('b_better');
    const two = { ...one, c: arm(1_000, 20) };
    expect(verdictOf(two)).toBe('no_difference');
    expect(verdictOf(two, 'c')).toBe('no_difference');
    // Each draft is told of by its own arm.
    const three = { a: arm(1_000, 20), b: arm(1_000, 20), c: arm(1_000, 45), d: arm(150, 1) };
    expect(verdictOf(three, 'c')).toBe('b_better');
    expect(verdictOf(three, 'd')).toBe('too_early');
    expect(zScoreOf({ a: arm(1_000, 20), b: arm(1_000, 20) }, 'c')).toBeNull();
    expect(revenueVerdictOf(three, 'c')).toBe('b_better');
    // Any draft clearly worse ends it.
    expect(guardrailTripped({ a: arm(1_000, 40), b: arm(1_000, 40), c: arm(1_000, 12) })).toBe(
      true,
    );
    expect(guardrailTripped({ a: arm(1_000, 40), b: arm(1_000, 40), c: arm(1_000, 38) })).toBe(
      false,
    );
  });
});
