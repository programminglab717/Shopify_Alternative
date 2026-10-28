import { toPublicId } from '@hatti/ids';
import { describe, expect, it } from 'vitest';
import { SELLING_PLAN_PROPERTY, planOfLine, planPrice } from './selling-plans.js';

const PLAN = '01937c4e-0000-7000-8000-000000000001';

describe('Selling plans (CAT-16, ADR-862)', () => {
  it("prices a unit at the plan's discount, to the nearest paisa", () => {
    expect(planPrice(100_000n, 10)).toBe(90_000n);
    expect(planPrice(99_999n, 15)).toBe(84_999n);
    expect(planPrice(250n, 50)).toBe(125n);
    expect(planPrice(100_000n, 0)).toBe(100_000n);
  });

  it('finds the plan a line names, of those its product is sold on', () => {
    const plans = [{ id: PLAN, name: 'Every month' }];
    const named = { [SELLING_PLAN_PROPERTY]: toPublicId('sellingPlan', PLAN) };
    expect(planOfLine(plans, named)).toEqual(plans[0]);
    expect(planOfLine([], named)).toBeNull();
    expect(planOfLine(undefined, named)).toBeNull();
    expect(planOfLine(plans, {})).toBeNull();
    expect(planOfLine(plans, { [SELLING_PLAN_PROPERTY]: 'not-a-plan' })).toBeNull();
  });
});
