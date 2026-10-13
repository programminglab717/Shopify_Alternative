import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
} from '../test-support';
import { sizeText } from './export-page';

const EARLIER = new Date(Date.now() - 3 * 86_400_000).toISOString();

const FAILED = {
  id: 'sxp_1',
  status: 'FAILED',
  size: null,
  error: 'The orders could not be exported: too many',
  createdAt: EARLIER,
  finishedAt: EARLIER,
  expiresAt: null,
  url: null,
};

function core(role: StaffRole) {
  let confirmed = false;
  let asked: Record<string, unknown> | null = null;
  let polls = 0;
  return fakeCore(
    role,
    (operation) => {
      switch (operation) {
        case 'StoreExports':
          // The worker has made it by the time the page asks again.
          if (asked && (polls += 1) > 1) {
            asked = {
              ...asked,
              status: 'READY',
              size: 2_516_582,
              finishedAt: LATER,
              expiresAt: LATER,
              url: 'https://files.hatti.pk/shops/1/exports/2.zip?signature=abc',
            };
          }
          return { storeExports: asked ? [asked, FAILED] : [FAILED] };
        case 'StoreExportCreate':
          if (!confirmed) return REAUTHENTICATE;
          asked = {
            id: 'sxp_2',
            status: 'PENDING',
            size: null,
            error: null,
            createdAt: new Date().toISOString(),
            finishedAt: null,
            expiresAt: null,
            url: null,
          };
          return { storeExportCreate: { storeExport: asked, userErrors: [] } };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    },
    (path) => {
      if (path === '/auth/reauthenticate/options') {
        return { methods: ['password'], passkeyOptions: null, googleOptions: null, phone: null };
      }
      if (path === '/auth/reauthenticate') {
        confirmed = true;
        return { authenticatedAt: LATER, sensitiveActionsUntil: LATER };
      }
      return {};
    },
  );
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation);

describe('The whole store exported (ADM-10, ADR-415)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is asked for by the owner, once they confirm who they are, and downloaded when ready', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Export your store/ }));
    const exports = await screen.findByRole('region', { name: 'Exports' });
    expect(
      within(exports).getByText('Not made: The orders could not be exported: too many'),
    ).toBeTruthy();
    expect(screen.getByText(/keep it safe, and delete it/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Export the whole store' }));
    await confirmIdentity('Password', 'a long password');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await within(exports).findByText('Being made…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Export the whole store' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(sentOf(fake, 'StoreExportCreate')).toHaveLength(2);

    // Asked again while it is made, it shows ready with its link.
    const link = await within(exports).findByRole('link', { name: 'Download' }, { timeout: 8000 });
    expect(link.getAttribute('href')).toBe(
      'https://files.hatti.pk/shops/1/exports/2.zip?signature=abc',
    );
    expect(within(exports).getByText(/^Ready, 2\.4 MB: downloads until /)).toBeTruthy();
  }, 15_000);

  it("tells a manager it is the owner's, asking nothing", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/export');

    expect(await screen.findByText("Only the shop's owner exports the whole store.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export the whole store' })).toBeNull();
    expect(sentOf(fake, 'StoreExports')).toEqual([]);
  });

  it('says sizes as people read them', () => {
    expect([100, 849_920, 2_516_582].map(sizeText)).toEqual(['1 KB', '830 KB', '2.4 MB']);
  });
});
