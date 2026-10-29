import { describe, expect, it } from 'vitest';
import { experimentArm, experimentCookie } from './experiments.js';

const experiment = { id: 'texp_1', themeId: 'thm-draft', version: 3, share: 20 };

describe("A shopper's arm of a theme experiment (OS-22, ADR-866)", () => {
  it('draws a new shopper by the share, keeps a returning one, and shows robots the live theme', () => {
    expect(experimentArm(experiment, null, false, () => 19)).toEqual({
      id: 'texp_1',
      arm: 'b',
      assigned: true,
    });
    expect(experimentArm(experiment, null, false, () => 20)?.arm).toBe('a');
    expect(experimentArm(experiment, 'texp_1.b', false, () => 99)).toEqual({
      id: 'texp_1',
      arm: 'b',
      assigned: false,
    });
    // A cookie of an experiment before is drawn again.
    expect(experimentArm(experiment, 'texp_0.b', false, () => 50)).toEqual({
      id: 'texp_1',
      arm: 'a',
      assigned: true,
    });
    expect(experimentArm(experiment, null, true, () => 0)).toEqual({
      id: 'texp_1',
      arm: 'a',
      assigned: false,
    });
    expect(experimentArm(undefined, 'texp_1.b', false)).toBeNull();
    expect(experimentCookie({ id: 'texp_1', arm: 'b', assigned: true }, { secure: true })).toBe(
      'hatti_ab=texp_1.b; Max-Age=2678400; Path=/; SameSite=Lax; Secure',
    );
  });

  it('gives each of several drafts its share in turn, the rest the live theme (ADR-931)', () => {
    const three = {
      ...experiment,
      share: 25,
      others: [
        { themeId: 'thm-c', version: 1 },
        { themeId: 'thm-d', version: 2 },
      ],
    };
    const drawn = (value: number) => experimentArm(three, null, false, () => value)?.arm;
    expect([0, 24, 25, 49, 50, 74, 75, 99].map(drawn)).toEqual([
      'b',
      'b',
      'c',
      'c',
      'd',
      'd',
      'a',
      'a',
    ]);
    // A returning shopper keeps a draft's arm the experiment has; another is drawn again.
    expect(experimentArm(three, 'texp_1.d', false, () => 99)?.arm).toBe('d');
    expect(experimentArm(experiment, 'texp_1.d', false, () => 99)).toEqual({
      id: 'texp_1',
      arm: 'a',
      assigned: true,
    });
  });
});
