import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';

const STORAGE = 'https://storage.hatti.test/s/zari';

const FILES = [
  { id: 'fil_3', filename: 'Eid lawn banner.jpg', mimeType: 'image/jpeg', alt: '' },
  { id: 'fil_2', filename: 'Size guide.pdf', mimeType: 'application/pdf', alt: '' },
  { id: 'fil_1', filename: 'lawn_2026.png', mimeType: 'image/png', alt: '' },
].map((file) => ({ ...file, url: `${STORAGE}/${file.id}` }));

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'ShopFiles': {
        // As the core finds them: each word of the search in the name, in any case.
        const words = String(variables.query ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const nodes = FILES.filter((file) =>
          words.every((word) => file.filename.toLowerCase().includes(word)),
        );
        return { files: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      case 'StagedUploadsCreate':
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: `${STORAGE}/new?expires=1&signature=s`,
                httpMethod: 'PUT',
                resourceUrl: `${STORAGE}/new`,
                parameters: [{ name: 'content-type', value: 'application/pdf' }],
              },
            ],
            userErrors: [],
          },
        };
      case 'FileCreate':
        return { fileCreate: { files: [{ id: 'fil_4' }], userErrors: [] } };
      case 'FileDelete':
        return { fileDelete: { deletedFileIds: variables.fileIds, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The online store's files (ADR-636)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the shop’s files, finds them by name, copies a link and deletes one', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    const copied: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
    });
    renderAdmin('/shop_1/online-store?tab=files');

    expect(await screen.findByText('Eid lawn banner.jpg')).toBeTruthy();
    expect(screen.getByText('Size guide.pdf')).toBeTruthy();

    type('Search by name', ' LAWN eid ');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Eid lawn banner.jpg')).toBeTruthy();
    expect(screen.queryByText('lawn_2026.png')).toBeNull();
    expect(sentOf(fake, 'ShopFiles').at(-1)).toEqual({
      first: 60,
      after: null,
      query: 'LAWN eid',
    });

    type('Search by name', 'invoice');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No file’s name has those words.')).toBeTruthy();

    type('Search by name', '');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the link to Size guide.pdf' }));
    await waitFor(() => expect(copied).toEqual([`${STORAGE}/fil_2`]));

    await press('Delete Size guide.pdf');
    const ask = screen.getByText(/^Delete Size guide\.pdf\?/).closest('[role="status"]')!;
    fireEvent.click(within(ask as HTMLElement).getByRole('button', { name: 'Delete the file' }));
    await waitFor(() => expect(sentOf(fake, 'FileDelete')).toEqual([{ fileIds: ['fil_2'] }]));
  });

  it('adds a PDF from the device, as it is', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=files');
    await screen.findByText('Size guide.pdf');

    fireEvent.change(screen.getByLabelText('Choose pictures or PDFs'), {
      target: {
        files: [new File([new Uint8Array(8)], 'Returns.pdf', { type: 'application/pdf' })],
      },
    });
    await waitFor(() => expect(sentOf(fake, 'FileCreate')).toHaveLength(1));
    expect(sentOf(fake, 'StagedUploadsCreate')).toEqual([
      { input: [{ filename: 'Returns.pdf', mimeType: 'application/pdf', fileSize: '8' }] },
    ]);
    expect(fake.uploads).toEqual([
      { url: `${STORAGE}/new?expires=1&signature=s`, type: 'application/pdf', size: 8 },
    ]);
    expect(sentOf(fake, 'FileCreate')).toEqual([
      { files: [{ originalSource: `${STORAGE}/new`, alt: '' }] },
    ]);
  });

  it('keeps the files to those who keep them', async () => {
    vi.stubGlobal('fetch', core('confirmation_agent').fetcher);
    renderAdmin('/shop_1/online-store?tab=files');
    await waitFor(() => expect(screen.queryByText('Loading your files…')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull();
  });
});
