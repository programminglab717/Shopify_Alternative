import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn } from '../test-support';

const CALENDAR = [
  {
    moment: 'EID_UL_FITR',
    startsOn: '2027-03-11',
    endsOn: '2027-03-13',
    promoteFrom: '2027-02-18',
    expected: true,
    kit: {
      code: 'EID27',
      percentage: 15,
      messageEnglish: 'Get ready for Eid: 15% off with code EID27.',
      messageUrdu: 'عید کی تیاری کریں: کوڈ EID27 کے ساتھ 15% رعایت۔',
    },
  },
  {
    moment: 'INDEPENDENCE_DAY',
    startsOn: '2027-08-14',
    endsOn: '2027-08-14',
    promoteFrom: '2027-07-31',
    expected: false,
    kit: {
      code: 'AZADI27',
      percentage: 14,
      messageEnglish: 'Jashn-e-Azadi Mubarak! 14% off for 14 August with code AZADI27.',
      messageUrdu: 'جشنِ آزادی مبارک! 14 اگست پر کوڈ AZADI27 کے ساتھ 14% رعایت۔',
    },
  },
];

function core(taken = false) {
  return fakeCore('marketer', (operation) => {
    switch (operation) {
      case 'MarketingCalendar':
        return { marketingCalendar: CALENDAR };
      case 'DiscountCodeCreate':
        return {
          discountCodeCreate: taken
            ? {
                discountCode: null,
                userErrors: [
                  { field: ['discountCode', 'code'], code: 'TAKEN', message: 'Already used' },
                ],
              }
            : { discountCode: { id: 'gid://hatti/DiscountCode/1' }, userErrors: [] },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const madeOf = (fake: ReturnType<typeof core>) =>
  fake.sent.filter((each) => each.operation === 'DiscountCodeCreate').map((each) => each.variables);

describe("Pakistan's marketing calendar (MKT-16, ADR-484)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists the moments ahead and makes a kit's code for its days in the shop's zone", async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/calendar');

    const eid = (await screen.findByRole('heading', { name: 'Eid ul Fitr' })).closest('li')!;
    expect(within(eid).getByText("Expected: the moon's sighting sets it")).toBeTruthy();
    expect(within(eid).getByText('15% off with EID27')).toBeTruthy();
    expect(within(eid).getByText(CALENDAR[0]!.kit.messageUrdu)).toBeTruthy();
    const azadi = screen.getByRole('heading', { name: 'Independence Day' }).closest('li')!;
    expect(within(azadi).queryByText("Expected: the moon's sighting sets it")).toBeNull();

    fireEvent.click(within(eid).getByRole('button', { name: 'Make code EID27' }));
    await waitFor(() =>
      expect(madeOf(fake)).toEqual([
        {
          discountCode: {
            code: 'EID27',
            title: 'Eid ul Fitr 2027',
            percentage: 15,
            // Karachi is five hours ahead.
            startsAt: '2027-02-17T19:00:00.000Z',
            endsAt: '2027-03-13T18:59:59.000Z',
          },
        },
      ]),
    );
    expect(await within(eid).findByText(/EID27 is made: it works from/)).toBeTruthy();
    expect(within(eid).getByRole('link', { name: 'Write a broadcast' })).toBeTruthy();
  });

  it('says why a code could not be made', async () => {
    const fake = core(true);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/calendar');

    fireEvent.click(await screen.findByRole('button', { name: 'Make code AZADI27' }));
    expect(await screen.findByText(/Already used/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make code AZADI27' })).toBeTruthy();
  });
});
