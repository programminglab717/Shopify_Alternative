import { describe, expect, it } from 'vitest';
import { guardrailTripped, verdictOf, zScoreOf, type ArmCounts } from './theme-experiments.js';

const arm = (sessions: number, converted: number): ArmCounts => ({
  sessions,
  added_to_cart: converted * 3,
  reached_checkout: converted * 2,
  converted,
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
});
