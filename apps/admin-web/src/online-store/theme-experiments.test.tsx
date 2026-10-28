import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const EARLIER = new Date(Date.now() - 3 * 86_400_000).toISOString();
const LATER = new Date(Date.now() + 11 * 86_400_000).toISOString();

const theme = (id: string, name: string, role: 'MAIN' | 'UNPUBLISHED') => ({
  id,
  name,
  role,
  base: 'hatti-base',
  previewUrl: `https://zari.hatti.pk/?preview_theme_id=${id}`,
  publishAt: null,
  createdAt: EARLIER,
  updatedAt: EARLIER,
});

const arm = (sessions: number, converted: number) => ({
  sessions,
  addedToCart: converted * 3,
  reachedCheckout: converted * 2,
  converted,
  conversionRate: converted / sessions,
});

describe('Theme experiments (OS-22, ADR-866)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('tries a draft on a share of shoppers, says how each theme sells, and ends it', async () => {
    signedIn();
    let experiments: Record<string, unknown>[] = [
      {
        id: 'texp_0',
        name: 'Bigger photos',
        themeId: 'th_2',
        share: 10,
        startedAt: EARLIER,
        endsAt: EARLIER,
        endedAt: EARLIER,
        endedReason: 'guardrail',
        live: arm(1_000, 40),
        draft: arm(1_000, 15),
        verdict: 'b_worse',
        countedAt: EARLIER,
      },
    ];
    const fake = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'Themes':
          return {
            themes: {
              nodes: [
                theme('th_1', 'Hatti Base', 'MAIN'),
                theme('th_2', 'Eid offer', 'UNPUBLISHED'),
              ],
            },
            platformThemes: [],
          };
        case 'ThemeStore':
          return { themeStore: [] };
        case 'ThemeExperiments':
          return { themeExperiments: experiments };
        case 'ThemeExperimentStart': {
          const input = variables.input as Record<string, unknown>;
          const started = {
            id: 'texp_1',
            ...input,
            startedAt: EARLIER,
            endsAt: LATER,
            endedAt: null,
            endedReason: null,
            live: arm(400, 8),
            draft: arm(100, 4),
            verdict: 'too_early',
            countedAt: null,
          };
          experiments = [started, ...experiments];
          return { themeExperimentStart: { themeExperiment: started, userErrors: [] } };
        }
        case 'ThemeExperimentEnd': {
          experiments = experiments.map((each) =>
            each.id === variables.id ? { ...each, endedAt: EARLIER, endedReason: 'staff' } : each,
          );
          return { themeExperimentEnd: { themeExperiment: experiments[0], userErrors: [] } };
        }
        default:
          return undefined;
      }
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');
    const section = within(
      (await screen.findByRole('heading', { name: 'Experiments' })).closest('section')!,
    );
    // The one before, ended by Hatti as its draft sold worse.
    expect(
      await section.findByText(/Hatti ended it on .*: the draft sold clearly worse\./),
    ).toBeTruthy();
    expect(section.getByText('1000 visits · 45 carts · 15 orders · 1.5% ordered')).toBeTruthy();

    type('What you’re trying', 'Eid banner');
    type('Shoppers shown the draft (%)', '25');
    fireEvent.click(section.getByRole('button', { name: 'Start experiment' }));
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'ThemeExperimentStart').at(-1)?.variables,
      ).toEqual({
        input: { name: 'Eid banner', themeId: 'th_2', share: 25, days: 14 },
      }),
    );
    expect(await section.findByText(/25% of shoppers see the draft, until/)).toBeTruthy();
    expect(section.getByText('Too early to tell: each theme needs 200 visits first.')).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: 'End experiment' }));
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'ThemeExperimentEnd').at(-1)?.variables,
      ).toEqual({
        id: 'texp_1',
      }),
    );
  });
});
