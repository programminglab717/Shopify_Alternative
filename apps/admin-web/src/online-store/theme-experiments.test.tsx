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

/** An arm whose orders were Rs 5,000 each. */
const arm = (sessions: number, converted: number) => ({
  sessions,
  addedToCart: converted * 3,
  reachedCheckout: converted * 2,
  converted,
  conversionRate: converted / sessions,
  revenue: { amount: (converted * 5_000).toFixed(2), currencyCode: 'PKR' },
  revenuePerSession: { amount: ((converted * 5_000) / sessions).toFixed(2), currencyCode: 'PKR' },
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
        revenueVerdict: 'b_worse',
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
            revenueVerdict: 'too_early',
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
    // With money a visit, and what that says (ADR-921).
    expect(
      section.getByText('1000 visits · 45 carts · 15 orders · 1.5% ordered · Rs 75 a visit'),
    ).toBeTruthy();
    expect(
      section.getByText('The draft brings in less money a visit than your live theme.'),
    ).toBeTruthy();

    type('What you’re trying', 'Eid banner');
    type('Shoppers shown the draft (%)', '25');
    fireEvent.click(section.getByRole('button', { name: 'Start experiment' }));
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'ThemeExperimentStart').at(-1)?.variables,
      ).toEqual({
        input: { name: 'Eid banner', themeId: 'th_2', otherThemeIds: [], share: 25, days: 14 },
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

  it('tries several drafts at once, each its share, and says of each how it sells (ADR-931)', async () => {
    signedIn();
    let experiments: Record<string, unknown>[] = [];
    const fake = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'Themes':
          return {
            themes: {
              nodes: [
                theme('th_1', 'Hatti Base', 'MAIN'),
                theme('th_2', 'Eid offer', 'UNPUBLISHED'),
                theme('th_3', 'Bigger photos', 'UNPUBLISHED'),
                theme('th_4', 'Urdu first', 'UNPUBLISHED'),
              ],
            },
            platformThemes: [],
          };
        case 'ThemeStore':
          return { themeStore: [] };
        case 'ThemeExperiments':
          return { themeExperiments: experiments };
        case 'ThemeExperimentStart': {
          const input = variables.input as { otherThemeIds: string[] } & Record<string, unknown>;
          const draft = (themeId: string, converted: number, verdict: string) => ({
            themeId,
            arm: arm(1_000, converted),
            verdict,
            revenueVerdict: verdict,
            // The last stopped alone as it sold clearly worse (ADR-939).
            stopped: verdict === 'b_worse',
          });
          const started = {
            id: 'texp_2',
            ...input,
            startedAt: EARLIER,
            endsAt: LATER,
            endedAt: null,
            endedReason: null,
            live: arm(1_000, 20),
            draft: arm(1_000, 20),
            verdict: 'no_difference',
            revenueVerdict: 'no_difference',
            drafts: [
              draft('th_2', 20, 'no_difference'),
              draft('th_3', 45, 'b_better'),
              draft('th_4', 8, 'b_worse'),
            ],
            countedAt: EARLIER,
          };
          experiments = [started];
          return { themeExperimentStart: { themeExperiment: started, userErrors: [] } };
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
    await section.findByLabelText('What you’re trying');
    type('What you’re trying', 'Three ways');
    const [second, third] = section.getAllByLabelText(
      'Another draft (optional)',
    ) as HTMLSelectElement[];
    fireEvent.change(second!, { target: { value: 'th_3' } });
    fireEvent.change(third!, { target: { value: 'th_4' } });
    expect(section.getByText('1 to 25, for each of 3 drafts.')).toBeTruthy();
    fireEvent.click(section.getByRole('button', { name: 'Start experiment' }));
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'ThemeExperimentStart').at(-1)?.variables,
      ).toEqual({
        input: {
          name: 'Three ways',
          themeId: 'th_2',
          otherThemeIds: ['th_3', 'th_4'],
          share: 20,
          days: 14,
        },
      }),
    );
    expect(await section.findByText(/20% of shoppers see each of 3 drafts, until/)).toBeTruthy();
    expect(section.getByText('Draft: Urdu first')).toBeTruthy();
    expect(
      section.getByText('Bigger photos: The draft sells better. You can publish it.'),
    ).toBeTruthy();
    expect(
      section.getByText(
        'Hatti stopped Urdu first: it sold clearly worse. Its shoppers see your live theme; the other drafts go on.',
      ),
    ).toBeTruthy();
  });

  it('gives another draft a share of its own, and says each draft’s (ADR-952)', async () => {
    signedIn();
    let experiments: Record<string, unknown>[] = [];
    const fake = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'Themes':
          return {
            themes: {
              nodes: [
                theme('th_1', 'Hatti Base', 'MAIN'),
                theme('th_2', 'Loud', 'UNPUBLISHED'),
                theme('th_3', 'Quiet', 'UNPUBLISHED'),
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
          const draft = (themeId: string, share: number) => ({
            themeId,
            share,
            arm: arm(100, 2),
            verdict: 'too_early',
            revenueVerdict: 'too_early',
            stopped: false,
          });
          const started = {
            id: 'texp_3',
            ...input,
            startedAt: EARLIER,
            endsAt: LATER,
            endedAt: null,
            endedReason: null,
            live: arm(100, 2),
            draft: arm(100, 2),
            verdict: 'too_early',
            revenueVerdict: 'too_early',
            drafts: [draft('th_2', 40), draft('th_3', 10)],
            countedAt: EARLIER,
          };
          experiments = [started];
          return { themeExperimentStart: { themeExperiment: started, userErrors: [] } };
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
    await section.findByLabelText('What you’re trying');
    type('What you’re trying', 'Loud or quiet');
    const [second] = section.getAllByLabelText('Another draft (optional)') as HTMLSelectElement[];
    fireEvent.change(second!, { target: { value: 'th_3' } });
    fireEvent.change(section.getByLabelText('Shoppers shown the draft (%)'), {
      target: { value: '40' },
    });
    fireEvent.change(section.getByLabelText('Its shoppers (%)'), { target: { value: '10' } });
    fireEvent.click(section.getByRole('button', { name: 'Start experiment' }));
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'ThemeExperimentStart').at(-1)?.variables,
      ).toEqual({
        input: {
          name: 'Loud or quiet',
          themeId: 'th_2',
          otherThemeIds: ['th_3'],
          share: 40,
          otherShares: [10],
          days: 14,
        },
      }),
    );
    expect(
      await section.findByText(/Shoppers see the drafts 40% · 10% of the time, until/),
    ).toBeTruthy();
  });

  it('changes the shares of a running experiment, asking none of a stopped draft (ADR-958)', async () => {
    signedIn();
    const draft = (themeId: string, share: number, stopped = false) => ({
      themeId,
      share,
      arm: arm(300, 6),
      verdict: stopped ? 'b_worse' : 'no_difference',
      revenueVerdict: 'no_difference',
      stopped,
    });
    let running: Record<string, unknown> = {
      id: 'texp_4',
      name: 'Three banners',
      themeId: 'th_2',
      share: 30,
      startedAt: EARLIER,
      endsAt: LATER,
      endedAt: null,
      endedReason: null,
      live: arm(300, 6),
      draft: arm(300, 6),
      verdict: 'no_difference',
      revenueVerdict: 'no_difference',
      drafts: [draft('th_2', 30), draft('th_3', 10), draft('th_4', 10, true)],
      countedAt: EARLIER,
    };
    const fake = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'Themes':
          return {
            themes: {
              nodes: [
                theme('th_1', 'Hatti Base', 'MAIN'),
                theme('th_2', 'Loud', 'UNPUBLISHED'),
                theme('th_3', 'Quiet', 'UNPUBLISHED'),
                theme('th_4', 'Urdu first', 'UNPUBLISHED'),
              ],
            },
            platformThemes: [],
          };
        case 'ThemeStore':
          return { themeStore: [] };
        case 'ThemeExperiments':
          return { themeExperiments: [running] };
        case 'ThemeExperimentSharesSet': {
          const shares = variables.shares as number[];
          running = {
            ...running,
            share: shares[0],
            drafts: [
              draft('th_2', shares[0]!),
              draft('th_3', shares[1]!),
              draft('th_4', shares[2]!, true),
            ],
          };
          return { themeExperimentSharesSet: { themeExperiment: running, userErrors: [] } };
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
    await section.findByLabelText('Shoppers shown Quiet (%)');
    // The stopped draft keeps its share, and isn't asked.
    expect(section.queryByLabelText('Shoppers shown Urdu first (%)')).toBeNull();
    const save = section.getByRole('button', { name: 'Change shares' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(section.getByLabelText('Shoppers shown Quiet (%)'), {
      target: { value: '20' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        fake.sent.filter((each) => each.operation === 'ThemeExperimentSharesSet').at(-1)?.variables,
      ).toEqual({ id: 'texp_4', shares: [30, 20, 10] }),
    );
    expect(
      await section.findByText(/Shoppers see the drafts 30% · 20% · 10% of the time, until/),
    ).toBeTruthy();
  });

  it('adds a draft to a running experiment, and takes one out (ADR-970)', async () => {
    signedIn();
    const draft = (themeId: string, share: number, takenOut = false) => ({
      themeId,
      share,
      arm: arm(300, 6),
      verdict: 'no_difference',
      revenueVerdict: 'no_difference',
      stopped: false,
      takenOut,
    });
    let running: Record<string, unknown> = {
      id: 'texp_5',
      name: 'Ramadan',
      themeId: 'th_2',
      share: 20,
      startedAt: EARLIER,
      endsAt: LATER,
      endedAt: null,
      endedReason: null,
      live: arm(300, 6),
      draft: arm(300, 6),
      verdict: 'no_difference',
      revenueVerdict: 'no_difference',
      drafts: [draft('th_2', 20)],
      countedAt: EARLIER,
    };
    const fake = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'Themes':
          return {
            themes: {
              nodes: [
                theme('th_1', 'Hatti Base', 'MAIN'),
                theme('th_2', 'Loud', 'UNPUBLISHED'),
                theme('th_3', 'Quiet', 'UNPUBLISHED'),
              ],
            },
            platformThemes: [],
          };
        case 'ThemeStore':
          return { themeStore: [] };
        case 'ThemeExperiments':
          return { themeExperiments: [running] };
        case 'ThemeExperimentDraftAdd':
          running = {
            ...running,
            drafts: [
              draft('th_2', 20),
              draft(variables.themeId as string, variables.share as number),
            ],
          };
          return { themeExperimentDraftAdd: { themeExperiment: running, userErrors: [] } };
        case 'ThemeExperimentDraftTakeOut':
          running = { ...running, drafts: [draft('th_2', 20, true), draft('th_3', 15)] };
          return { themeExperimentDraftTakeOut: { themeExperiment: running, userErrors: [] } };
        case 'ThemeExperimentDraftLetBackIn':
          running = { ...running, drafts: [draft('th_2', 20), draft('th_3', 15)] };
          return { themeExperimentDraftLetBackIn: { themeExperiment: running, userErrors: [] } };
        default:
          return undefined;
      }
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');
    const section = within(
      (await screen.findByRole('heading', { name: 'Experiments' })).closest('section')!,
    );
    // Only the drafts it doesn't show are offered.
    const select = (await section.findByLabelText('Add a draft')) as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual(['Quiet']);
    fireEvent.change(section.getByLabelText('Its share (%)'), { target: { value: '15' } });
    fireEvent.click(section.getByRole('button', { name: 'Add draft' }));
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'ThemeExperimentDraftAdd')?.variables,
      ).toEqual({ id: 'texp_5', themeId: 'th_3', share: 15 }),
    );
    await section.findByLabelText('Shoppers shown Quiet (%)');
    fireEvent.click(await section.findByRole('button', { name: 'Take Loud out' }));
    expect(
      await section.findByText(
        'You took Loud out. Its shoppers see your live theme; the other drafts go on.',
      ),
    ).toBeTruthy();
    expect(
      fake.sent.find((each) => each.operation === 'ThemeExperimentDraftTakeOut')?.variables,
    ).toEqual({ id: 'texp_5', themeId: 'th_2' });
    // Taken out, it isn't asked its share, nor offered to take out again.
    expect(section.queryByLabelText('Shoppers shown Loud (%)')).toBeNull();
    expect(section.queryByRole('button', { name: 'Take Loud out' })).toBeNull();
    // But it may be let back in (ADR-977).
    fireEvent.click(section.getByRole('button', { name: 'Let Loud back in' }));
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'ThemeExperimentDraftLetBackIn')?.variables,
      ).toEqual({ id: 'texp_5', themeId: 'th_2' }),
    );
    expect(await section.findByRole('button', { name: 'Take Loud out' })).toBeTruthy();
  });
});
