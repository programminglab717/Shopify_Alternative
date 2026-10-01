import { describe, expect, it } from 'vitest';
import {
  assessRisk,
  defaultRiskSettings,
  heldForRiskMessage,
  holdsForRisk,
  riskLevelOf,
  type RiskInputs,
} from './risk.js';

const BASE: RiskInputs = {
  total: 250_000n,
  currency: 'PKR',
  units: 1,
  address: {
    name: 'Ayesha Khan',
    phone: '+923001234567',
    address1: 'House 12, Street 4, Block 5',
    address2: null,
    landmark: null,
    city: 'Karachi',
    provinceCode: 'SD',
    zip: null,
  },
  history: { orders: 3, delivered: 1, returned: 0, cancelled: 0 },
  recentOrderNumber: null,
  highValue: 1_500_000n,
};

describe('COD risk rules', () => {
  it('scores an ordinary order low, with no reasons', () => {
    expect(assessRisk(BASE)).toEqual({ score: 0, level: 'low', reasons: [] });
  });

  it('adds up the reasons, strongest first', () => {
    const assessment = assessRisk({
      ...BASE,
      total: 1_850_000n,
      units: 12,
      address: { ...BASE.address, address1: 'Near masjid', city: 'Unknownabad' },
      history: { orders: 4, delivered: 0, returned: 2, cancelled: 2 },
      recentOrderNumber: 1043,
    });
    expect(assessment.score).toBe(100);
    expect(assessment.level).toBe('high');
    expect(
      assessment.reasons.map((reason) => [reason.code, reason.weight, reason.message]),
    ).toEqual([
      ['refused_deliveries', 50, 'Refused 2 deliveries from this shop'],
      ['recent_order', 25, 'Another order from this number in the last 6 hours: #1043'],
      ['high_value', 20, 'High value: Rs 18,500'],
      ['many_units', 15, '12 items, more than most orders'],
      ['no_house_number', 15, 'The address has no house or street number'],
      ['cancelled_orders', 10, 'Cancelled 2 orders before'],
      ['unknown_city', 10, '"Unknownabad" is not a city couriers know by that spelling'],
    ]);
  });

  it('gives first orders a little risk and trusted customers less', () => {
    expect(
      assessRisk({ ...BASE, history: { orders: 0, delivered: 0, returned: 0, cancelled: 0 } }),
    ).toMatchObject({ score: 10, level: 'low', reasons: [{ code: 'first_order' }] });
    // A trusted customer's high-value order stays low.
    expect(
      assessRisk({
        ...BASE,
        total: 2_000_000n,
        history: { orders: 5, delivered: 4, returned: 0, cancelled: 1 },
      }),
    ).toMatchObject({
      score: 0,
      reasons: [
        { code: 'high_value', weight: 20 },
        { code: 'trusted_customer', weight: -20 },
      ],
    });
    // One refusal outweighs deliveries: the customer is no longer trusted.
    expect(
      assessRisk({ ...BASE, history: { orders: 5, delivered: 4, returned: 1, cancelled: 0 } }),
    ).toMatchObject({ score: 35, level: 'medium' });
  });

  it('keeps each address rule below medium on its own', () => {
    const vague = assessRisk({
      ...BASE,
      address: { ...BASE.address, address1: 'Near', city: 'Unknownabad' },
    });
    // All three together reach medium; each alone stays low.
    expect(vague).toMatchObject({ score: 35, level: 'medium' });
    expect(assessRisk({ ...BASE, address: { ...BASE.address, city: 'Unknownabad' } }).level).toBe(
      'low',
    );
    expect(
      assessRisk({ ...BASE, address: { ...BASE.address, address1: 'Near masjid' } }).level,
    ).toBe('low');
  });

  it('holds at the threshold, and says what raised the score', () => {
    const settings = defaultRiskSettings('PKR');
    expect(settings).toEqual({ holdAt: 60, highValue: 1_500_000n });
    expect([59, 60].map((score) => holdsForRisk(settings, score))).toEqual([false, true]);
    expect(holdsForRisk({ ...settings, holdAt: null }, 100)).toBe(false);

    const assessment = assessRisk({
      ...BASE,
      total: 2_000_000n,
      history: { orders: 5, delivered: 4, returned: 1, cancelled: 0 },
    });
    expect(heldForRiskMessage(assessment)).toBe(
      'Held for review: risk 0.55 (medium). Refused a delivery from this shop; ' +
        'High value: Rs 20,000',
    );
  });

  it('draws the levels at 30 and 60', () => {
    expect([0, 29, 30, 59, 60, 100].map(riskLevelOf)).toEqual([
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
    ]);
  });
});
