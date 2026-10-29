import { toPublicId } from '@hatti/ids';
import { describe, expect, it } from 'vitest';
import { SELLING_PLAN_PROPERTY, planOfLine, planPrice, planSells } from './selling-plans.js';

const PLAN = '01937c4e-0000-7000-8000-000000000001';
const VARIANT = '01937c4e-0000-7000-8000-000000000002';
const OTHER = '01937c4e-0000-7000-8000-000000000003';

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
    expect(planOfLine(plans, named, VARIANT)).toEqual(plans[0]);
    expect(planOfLine([], named, VARIANT)).toBeNull();
    expect(planOfLine(undefined, named, VARIANT)).toBeNull();
    expect(planOfLine(plans, {}, VARIANT)).toBeNull();
    expect(planOfLine(plans, { [SELLING_PLAN_PROPERTY]: 'not-a-plan' }, VARIANT)).toBeNull();
  });

  it('sells a plan for chosen variants on those alone (ADR-930)', () => {
    const plans = [{ id: PLAN, name: 'Every month', variantIds: [VARIANT] }];
    const named = { [SELLING_PLAN_PROPERTY]: toPublicId('sellingPlan', PLAN) };
    expect(planOfLine(plans, named, VARIANT)).toEqual(plans[0]);
    expect(planOfLine(plans, named, OTHER)).toBeNull();
    expect(planSells({ variantIds: null }, OTHER)).toBe(true);
    expect(planSells({}, OTHER)).toBe(true);
    expect(planSells({ variantIds: [VARIANT] }, OTHER)).toBe(false);
  });
});
