import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationRequest } from '../api/types';
import type { StaffRole } from '../auth/session';
import {
  confirmIdentity,
  fakeCore,
  LATER,
  REAUTHENTICATE,
  renderAdmin,
  signedIn,
  type,
} from '../test-support';

const STORAGE = 'https://files.hatti.pk/shops/1/files/staged';
const EARLIER = new Date(Date.now() - 3 * 86_400_000).toISOString();

const APPROVED: VerificationRequest = {
  id: 'vrf_1',
  level: 'IDENTITY',
  name: 'Sana Ahmed',
  cnicLast4: '5671',
  ntn: null,
  status: 'APPROVED',
  createdAt: EARLIER,
  decidedAt: EARLIER,
  answer: null,
};

const REFUSED: VerificationRequest = {
  id: 'vrf_2',
  level: 'BUSINESS',
  name: 'Zari Pvt Ltd',
  cnicLast4: null,
  ntn: '1234567-8',
  status: 'REFUSED',
  createdAt: EARLIER,
  decidedAt: EARLIER,
  answer: 'the certificate is blurred',
};

/** A fake core keeping the shop's requests, asking the owner to prove who they are first. */
function core(role: StaffRole, requests: VerificationRequest[] = []) {
  let confirmed = false;
  let staged = 0;
  const kept = [...requests];
  return fakeCore(
    role,
    (operation, variables) => {
      switch (operation) {
        case 'ShopVerification':
          return {
            shopVerification: {
              level: kept.some((request) => request.status === 'APPROVED') ? 'IDENTITY' : null,
              requests: kept,
            },
          };
        case 'StagedUploadsCreate':
          staged += 1;
          return {
            stagedUploadsCreate: {
              stagedTargets: [
                {
                  url: `${STORAGE}/${staged}?signature=s`,
                  httpMethod: 'PUT',
                  resourceUrl: `${STORAGE}/${staged}`,
                  parameters: [{ name: 'content-type', value: 'image/jpeg' }],
                },
              ],
              userErrors: [],
            },
          };
        case 'ShopVerificationSubmit': {
          if (!confirmed) return REAUTHENTICATE;
          const input = variables.input as { level: 'IDENTITY'; name: string };
          kept.unshift({
            id: 'vrf_9',
            level: input.level,
            name: input.name,
            cnicLast4: '5671',
            ntn: null,
            status: 'WAITING',
            createdAt: new Date().toISOString(),
            decidedAt: null,
            answer: null,
          });
          return {
            shopVerificationSubmit: { request: { id: 'vrf_9', status: 'WAITING' }, userErrors: [] },
          };
        }
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

const photo = (name: string, type = 'image/jpeg') => new File([new Uint8Array(8)], name, { type });

describe("The shop's verification by Hatti (ONB-11)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends the owner’s CNIC with its photos, once they confirm who they are, and shows it waiting', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Verification/ }));
    expect(await screen.findByText('Not verified yet')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Verify who runs the shop' })).toBeTruthy();

    type('Name as on the CNIC', 'Sana Ahmed');
    type('CNIC number', '35202-1234567-1');
    const files = screen.getByLabelText('Photos or PDF');
    // Only photos and PDFs, three at most.
    fireEvent.change(files, { target: { files: [photo('notes.txt', 'text/plain')] } });
    expect(screen.getByText('notes.txt is not a photo or a PDF.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Send to Hatti' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(files, { target: { files: [photo('front.jpg'), photo('back.jpg')] } });
    expect(screen.getByText('front.jpg')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send to Hatti' })));
    await confirmIdentity('Password', 'a long password');
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Confirm' })));

    expect(await screen.findByText(/Hatti is checking what you sent on/)).toBeTruthy();
    // Each photo put to storage once, before the owner was asked to confirm, and sent with the CNIC.
    expect(fake.uploads.map((upload) => upload.url)).toEqual([
      `${STORAGE}/1?signature=s`,
      `${STORAGE}/2?signature=s`,
    ]);
    const sent = fake.sent.filter((each) => each.operation === 'ShopVerificationSubmit');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.variables).toEqual({
      input: {
        level: 'IDENTITY',
        name: 'Sana Ahmed',
        cnic: '35202-1234567-1',
        documents: [`${STORAGE}/1`, `${STORAGE}/2`],
      },
    });
    // The form gives way to the request waiting.
    expect(screen.queryByRole('button', { name: 'Send to Hatti' })).toBeNull();
    const history = screen.getByRole('region', { name: 'Requests' });
    expect(within(history).getByText(/Being checked · Sana Ahmed · CNIC …5671/)).toBeTruthy();
  });

  it('shows managers what is verified and why the last request was refused, the form the owner’s alone', async () => {
    const fake = core('manager', [REFUSED, APPROVED]);
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/verification');

    expect(await screen.findByText('Verified: the seller’s identity')).toBeTruthy();
    expect(screen.getByText('Hatti could not verify it: the certificate is blurred')).toBeTruthy();
    expect(screen.getByText('Only the shop’s owner asks Hatti to verify it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send to Hatti' })).toBeNull();
    const history = screen.getByRole('region', { name: 'Requests' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(history).getByText(/Not verified · Zari Pvt Ltd · NTN 1234567-8 · the certificate/),
    ).toBeTruthy();
  });
});
