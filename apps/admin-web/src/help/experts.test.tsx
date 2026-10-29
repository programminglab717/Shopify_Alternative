import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const LENS = {
  id: 'expt_1',
  businessName: 'Lens Lahore',
  website: 'https://lens.example.pk',
  headline: 'Product photos for clothing brands',
  about: 'Studio and on location.',
  services: ['photography', 'content'],
  cities: ['Lahore', 'Online'],
  languages: ['ur', 'en'],
  startingPrice: 15000,
  listed: true,
  rating: { average: 4.5, count: 2 },
};

function core(role: StaffRole) {
  return fakeCore(
    role,
    () => ({}),
    (path) => {
      if (path.startsWith('/auth/experts?')) {
        const asked = new URLSearchParams(path.slice(path.indexOf('?')));
        const service = asked.get('service');
        return { experts: !service || LENS.services.includes(service) ? [LENS] : [] };
      }
      if (path === '/auth/experts/expt_1/enquiries') return { enquiry: { id: 'q1' } };
      // Reviews by the shops that hired them (ADR-917): this one gave the expert access.
      if (path === '/auth/experts/expt_1/reviews?shopId=shop_1') {
        return {
          reviews: [
            {
              shopName: 'Kapra',
              rating: 4,
              body: 'Good light, a day late.',
              updatedAt: '2026-10-20T09:00:00Z',
            },
          ],
          shop: { allowed: role === 'owner', review: null },
        };
      }
      if (path === '/auth/experts/expt_1/reviews') {
        return {
          review: { shopName: 'Zari', rating: 5, body: '', updatedAt: '2026-10-29T09:00:00Z' },
        };
      }
      if (path === '/auth/partner/expert') return { expert: null };
      if (path === '/auth/partner/enquiries') {
        return {
          enquiries: [
            {
              id: 'q1',
              shop: { name: 'Zari', handle: 'zari' },
              sender: { name: 'Sana', email: 'sana@zari.pk' },
              service: 'migration',
              message: 'We sell on Shopify and want to move 400 products.',
              createdAt: '2026-10-28T09:00:00Z',
            },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  );
}

describe('Experts shops hire (PRT-03, ADR-855)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('finds experts by service, and sends one an enquiry for the shop', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/help');

    fireEvent.click(await screen.findByRole('link', { name: /^Hire an expert/ }));
    const list = await screen.findByRole('list', { name: 'Hire an expert' });
    expect(within(list).getByText('Lens Lahore')).toBeTruthy();
    expect(within(list).getByText('From Rs 15,000')).toBeTruthy();
    expect(within(list).getByText('Product photography · Writing')).toBeTruthy();
    expect(within(list).getByText('Lahore, Online · Urdu, English')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'ads' } });
    expect(await screen.findByText('No expert offers that yet.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'photography' } });

    await screen.findByRole('button', { name: 'Contact Lens Lahore' });
    await press('Contact Lens Lahore');
    fireEvent.change(screen.getByLabelText('Your message'), {
      target: { value: 'Forty kurtas to shoot before Eid.' },
    });
    await press('Send the enquiry');
    expect(await screen.findByText('Sent to Lens Lahore: they answer you by email.')).toBeTruthy();
    expect(
      fake.sent.find((each) => each.operation === '/auth/experts/expt_1/enquiries')?.variables,
    ).toEqual({
      shopId: 'shop_1',
      service: 'photography',
      message: 'Forty kurtas to shoot before Eid.',
    });
  });

  it("shows experts' ratings and reviews, and takes the shop's own once it hired them (ADR-917)", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/help/experts');

    expect(await screen.findByText('4.5 out of 5, from 2 shops')).toBeTruthy();
    await press('Reviews of Lens Lahore');
    const reviews = await screen.findByRole('list', { name: "Shops' reviews of Lens Lahore" });
    expect(within(reviews).getByText('Kapra')).toBeTruthy();
    expect(within(reviews).getByText('Good light, a day late.')).toBeTruthy();
    expect(within(reviews).getByText('4 out of 5')).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Your shop's rating"), { target: { value: '5' } });
    await press('Post your review');
    expect(await screen.findByText('Thank you: your review is posted.')).toBeTruthy();
    expect(
      fake.sent.find((each) => each.operation === '/auth/experts/expt_1/reviews')?.variables,
    ).toEqual({ shopId: 'shop_1', rating: 5, body: null });
  });

  it('leaves contacting experts to owners and managers', async () => {
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/help/experts');
    expect(await screen.findByText('Lens Lahore')).toBeTruthy();
    expect(screen.getByText("The shop's owner and managers contact experts.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Contact Lens Lahore' })).toBeNull();
  });

  it("saves a partner's profile, and shows the enquiries shops sent", async () => {
    const fake = fakeCore(
      'owner',
      () => ({}),
      (path) => {
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
        if (path === '/auth/partner/enquiries') {
          return {
            enquiries: [
              {
                id: 'q1',
                shop: { name: 'Zari', handle: 'zari' },
                sender: { name: 'Sana', email: 'sana@zari.pk' },
                service: 'migration',
                message: 'We sell on Shopify and want to move 400 products.',
                createdAt: '2026-10-28T09:00:00Z',
              },
            ],
          };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/partners');

    expect(
      await screen.findByText('Sana of Zari (zari), about Moving from another platform'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Answer by email' }).getAttribute('href')).toBe(
      'mailto:sana@zari.pk',
    );
    type('What you do, in a line', 'Stores set up and moved from Shopify');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Store setup' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Moving from another platform' }));
    type('Cities, comma separated', 'Lahore, Online');
    fireEvent.change(screen.getByLabelText('Starting price in rupees, 0 to ask'), {
      target: { value: '25000' },
    });
    await press('Save the profile');
    await waitFor(() =>
      expect(
        fake.sent.find(
          (each) => each.operation === '/auth/partner/expert' && each.method === 'POST',
        )?.variables,
      ).toEqual({
        headline: 'Stores set up and moved from Shopify',
        about: '',
        services: ['setup', 'migration'],
        cities: ['Lahore', 'Online'],
        languages: ['ur'],
        startingPrice: 25000,
      }),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });
});
