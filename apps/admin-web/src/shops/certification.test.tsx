import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn } from '../test-support';

const words = (en: string) => ({ en, ur: `${en} (ur)` });

const COURSE = {
  version: '2026-10',
  passMark: 1,
  lessons: [{ id: 'cod', title: words('Cash on delivery'), body: words('Confirm every order.') }],
  questions: [
    {
      id: 'q-confirm',
      prompt: words('Which orders are packed?'),
      options: [words('Every order'), words('Confirmed orders')],
    },
  ],
};

function core() {
  let certificate: unknown = null;
  return fakeCore(
    'owner',
    () => ({}),
    (path, body, method) => {
      if (path === '/auth/partner') {
        return {
          partner: {
            businessName: 'Rang Studio',
            website: null,
            referralCode: 'rang0001',
            joinedAt: '2026-10-17T10:00:00Z',
          },
          stores: [],
          earnings: null,
        };
      }
      if (path === '/auth/partner/apps') return { apps: [] };
      if (path === '/auth/partner/themes') return { themes: [] };
      if (path === '/auth/partner/expert') return { expert: null };
      if (path === '/auth/partner/enquiries') return { enquiries: [] };
      if (path === '/auth/partner/certification' && method === 'GET') {
        return { course: COURSE, certificate, triesLeft: certificate ? 2 : 3 };
      }
      if (path === '/auth/partner/certification') {
        const { answers } = body as { answers: Record<string, number> };
        const passed = answers['q-confirm'] === 1;
        certificate = passed
          ? {
              courseVersion: '2026-10',
              score: 1,
              passedAt: '2026-10-28T09:00:00Z',
              expiresAt: '2027-10-28T09:00:00Z',
            }
          : null;
        return { score: passed ? 1 : 0, passed, wrong: passed ? [] : ['q-confirm'], certificate };
      }
      throw new Error(`unexpected ${path}`);
    },
  );
}

describe("Hatti's course for partners (PRT-04, ADR-858)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('teaches, asks, says what was wrong, and certifies once passed', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/partners');

    const section = await screen.findByRole('region', { name: 'Hatti certification' });
    expect(within(section).getByText('Cash on delivery')).toBeTruthy();
    expect(within(section).getByText('Tries left today: 3')).toBeTruthy();
    fireEvent.click(within(section).getByRole('radio', { name: 'Every order' }));
    await press('Send my answers');
    expect(await within(section).findByText('Not this one: read its lesson again.')).toBeTruthy();
    expect(within(section).getByText(/^0 of 1 right: you need 1\./)).toBeTruthy();

    fireEvent.click(within(section).getByRole('radio', { name: 'Confirmed orders' }));
    await press('Send my answers');
    expect(await within(section).findByText('1 of 1 right: you are Hatti certified.')).toBeTruthy();
    expect(await within(section).findByText(/^You are Hatti certified, until/)).toBeTruthy();
    expect(
      fake.sent
        .filter(
          (each) => each.operation === '/auth/partner/certification' && each.method === 'POST',
        )
        .map((each) => each.variables),
    ).toEqual([{ answers: { 'q-confirm': 0 } }, { answers: { 'q-confirm': 1 } }]);
  });
});
