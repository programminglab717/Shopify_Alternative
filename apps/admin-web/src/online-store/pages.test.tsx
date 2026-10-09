import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { sectionsOf } from '../shell/shell';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';
import { htmlFromText, textFromHtml } from './page-body';

const EARLIER = '2026-01-05T09:00:00Z';

const RETURNS = {
  id: 'pag_1',
  title: 'Returns',
  handle: 'returns',
  body: '<p>Seven days to send it back.</p>\n<p>Call us &amp; we&#39;ll help.<br>No questions.</p>',
  isPublished: true,
  publishedAt: EARLIER,
};

const SIZES = {
  id: 'pag_2',
  title: 'Size guide',
  handle: 'size-guide',
  body: '<p>Measure <strong>chest</strong> and length.</p>',
  isPublished: false,
  publishedAt: null,
};

function core(role: StaffRole) {
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Pages':
        return {
          pages: {
            nodes: [
              RETURNS,
              SIZES,
              {
                ...RETURNS,
                id: 'pag_3',
                title: 'Eid sale',
                handle: 'eid-sale',
                publishedAt: LATER,
              },
            ].map(({ body: _body, ...page }) => page),
          },
        };
      case 'Page':
        return { page: variables.id === 'pag_2' ? SIZES : RETURNS };
      case 'PageCreate':
        return { pageCreate: { page: { id: 'pag_9' }, userErrors: [] } };
      case 'PageUpdate':
        return { pageUpdate: { page: { id: variables.id }, userErrors: [] } };
      case 'PageDelete':
        return { pageDelete: { deletedPageId: 'pag_1', userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe("The online store's pages", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('writes plain text as paragraphs, and reads back only what it wrote', () => {
    expect(htmlFromText('Seven days.\n\n  Call us & ask <nicely>.\nAny time.\n\n\n')).toBe(
      '<p>Seven days.</p>\n<p>Call us &amp; ask &lt;nicely&gt;.<br>Any time.</p>',
    );
    expect(textFromHtml(RETURNS.body)).toBe(
      "Seven days to send it back.\n\nCall us & we'll help.\nNo questions.",
    );
    expect(textFromHtml(htmlFromText('One\n\nTwo\nThree'))).toBe('One\n\nTwo\nThree');
    expect(textFromHtml(SIZES.body)).toBeNull();
    expect(textFromHtml('<p>5&nbsp;days</p>')).toBeNull();
    expect(textFromHtml('')).toBe('');
  });

  it('lists pages with whether they show, and writes a new one hidden for now', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store');

    const returns = await screen.findByRole('link', { name: /Returns/ });
    expect(returns.textContent).toContain('/pages/returns');
    expect(returns.textContent).toContain('Shown');
    expect(screen.getByRole('link', { name: /Size guide/ }).textContent).toContain('Hidden');
    expect(screen.getByRole('link', { name: /Eid sale/ }).textContent).toMatch(/Shows from/);

    fireEvent.click(screen.getByRole('link', { name: 'New page' }));
    await screen.findByLabelText('Title');
    type('Title', 'How to order');
    type('Text', 'Pick your size.\n\nPay when it comes.');
    fireEvent.click(screen.getByLabelText('Hidden for now'));
    fireEvent.click(screen.getByRole('button', { name: 'Save the page' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PageCreate')).toEqual({
        page: {
          title: 'How to order',
          body: '<p>Pick your size.</p>\n<p>Pay when it comes.</p>',
          isPublished: false,
        },
      }),
    );
    await waitFor(() => expect(sentOf(fake, 'Page')).toEqual({ id: 'pag_9' }));
  });

  it('changes only what was changed on a page, and keeps formatting from elsewhere as HTML', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/pages/pag_1');

    const text = (await screen.findByLabelText('Text')) as HTMLTextAreaElement;
    expect(text.value).toBe("Seven days to send it back.\n\nCall us & we'll help.\nNo questions.");
    type('Title', 'Returns and exchanges');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PageUpdate')).toEqual({
        id: 'pag_1',
        page: { title: 'Returns and exchanges' },
      }),
    );
    cleanup();

    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/pages/pag_2');
    const html = (await screen.findByLabelText('Text, as HTML')) as HTMLTextAreaElement;
    expect(html.value).toBe(SIZES.body);
    fireEvent.change(html, { target: { value: '<p>Measure <strong>chest</strong> only.</p>' } });
    fireEvent.click(screen.getByLabelText('Shown on the storefront'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'PageUpdate')).toEqual({
        id: 'pag_2',
        page: { body: '<p>Measure <strong>chest</strong> only.</p>', isPublished: true },
      }),
    );
  });

  it('deletes a page after asking, and is for those who write content', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/pages/pag_1');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete the page' }));
    expect(screen.getByText(/Menus that link to it leave the link out/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(fake, 'PageDelete')).toEqual({ id: 'pag_1' }));
    await screen.findByRole('link', { name: /Size guide/ });
    cleanup();

    expect(sectionsOf('marketer').map((item) => item.label)).toContain('nav.onlineStore');
    expect(sectionsOf('packer').map((item) => item.label)).not.toContain('nav.onlineStore');
    vi.stubGlobal('fetch', core('packer').fetcher);
    renderAdmin('/shop_1/online-store');
    expect(await screen.findByText("Your role does not write the shop's pages.")).toBeTruthy();
    expect(within(document.body).queryByRole('link', { name: 'New page' })).toBeNull();
  });
});
