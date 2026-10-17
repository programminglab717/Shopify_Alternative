import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../i18n/format';
import { sectionsOf } from '../shell/shell';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { HELP_ARTICLES, searchArticles } from './articles';

const HOURS = { en: 'Monday to Saturday, 10am to 7pm', ur: 'پیر سے ہفتہ، صبح 10 سے شام 7' };

const answered = {
  id: 'sreq_1',
  channel: 'ADMIN',
  topic: 'COURIERS',
  message: 'PostEx bookings fail for Multan.',
  callBack: null,
  status: 'ANSWERED',
  answer: 'PostEx fixed Multan; book again.',
  answeredBy: 'Ayesha',
  answeredAt: '2026-10-16T09:00:00Z',
  createdAt: '2026-10-16T07:00:00Z',
  messages: [],
};

const message = (id: string, at: string, extra: object) => ({
  id,
  direction: 'INBOUND',
  body: null,
  mediaKind: null,
  at,
  status: null,
  error: null,
  ...extra,
});

/** Written to Hatti's support WhatsApp (ADR-560): its first message is the request's own. */
const onWhatsapp = {
  id: 'sreq_3',
  channel: 'WHATSAPP',
  topic: 'OTHER',
  message: 'Orders will not book for Multan.',
  callBack: null,
  status: 'ANSWERED',
  answer: 'PostEx fixed Multan; book again.',
  answeredBy: 'Ayesha',
  answeredAt: '2026-10-16T06:00:00Z',
  createdAt: '2026-10-16T05:00:00Z',
  messages: [
    message('smsg_1', '2026-10-16T05:00:00Z', { body: 'Orders will not book for Multan.' }),
    message('smsg_2', '2026-10-16T05:01:00Z', { mediaKind: 'image' }),
    message('smsg_3', '2026-10-16T05:02:00Z', { mediaKind: 'contacts' }),
    message('smsg_4', '2026-10-16T05:30:00Z', {
      direction: 'OUTBOUND',
      body: 'Which courier account?',
      status: 'READ',
    }),
    message('smsg_5', '2026-10-16T05:40:00Z', { body: 'PostEx, the main one.' }),
    message('smsg_6', '2026-10-16T06:00:00Z', {
      direction: 'OUTBOUND',
      body: 'PostEx fixed Multan; book again.',
      status: 'DELIVERED',
    }),
    message('smsg_7', '2026-10-17T09:00:00Z', {
      direction: 'OUTBOUND',
      body: 'Did it work?',
      status: 'FAILED',
      error: 'More than 24 hours since you last wrote.',
    }),
  ],
};

const support = (plan: string, requests: object[] = [answered]) => ({
  hattiSupport: {
    plan,
    channel: plan === 'FREE' ? 'HELP_CENTRE' : 'PRIORITY_WHATSAPP',
    answerWithinHours: plan === 'FREE' ? 48 : 8,
    whatsapp: plan === 'FREE' ? null : '+923001112233',
    phone: null,
    email: 'help@hatti.pk',
    hours: HOURS,
    requests,
  },
});

function helpCore(
  plan = 'GROWTH',
  created: object = { userErrors: [] },
  requests: object[] = [answered],
) {
  return fakeCore('packer', (operation, variables) => {
    switch (operation) {
      case 'HattiSupport':
        return support(plan, requests);
      case 'SupportRequestCreate':
        return {
          supportRequestCreate: {
            request: null,
            ...created,
            ...('request' in created
              ? {}
              : {
                  request: {
                    ...answered,
                    id: 'sreq_2',
                    status: 'OPEN',
                    message: (variables.input as { message: string }).message,
                    answer: null,
                    answeredBy: null,
                    answeredAt: null,
                  },
                }),
          },
        };
      case 'SupportRequestClose':
        return {
          supportRequestClose: {
            request: { ...answered, status: 'CLOSED' },
            userErrors: [],
          },
        };
      default:
        return {};
    }
  });
}

const sentOf = (fake: ReturnType<typeof helpCore>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Help: the help centre and Hatti’s people (BIL-05, ADR-508)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('finds the help centre’s articles by their words in English or Urdu', () => {
    expect(searchArticles('')).toHaveLength(HELP_ARTICLES.length);
    expect(searchArticles('COURIER statement').map((each) => each.id)).toEqual(['courier-cash']);
    expect(searchArticles('ڈومین').map((each) => each.id)).toEqual(['own-domain']);
    expect(searchArticles('nothing like this')).toEqual([]);
    // Help is for everyone at the shop.
    expect(sectionsOf('packer').map((item) => item.label)).toContain('nav.help');
  });

  it('shows how the shop reaches Hatti as its plan allows, and sends a request', async () => {
    const fake = helpCore();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/help');

    expect(
      await screen.findByText('Growth plan: priority WhatsApp, answered within 8 working hours.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'WhatsApp Hatti' }).getAttribute('href')).toBe(
      'https://wa.me/923001112233',
    );
    expect(screen.getByRole('link', { name: 'Email Hatti' }).getAttribute('href')).toBe(
      'mailto:help@hatti.pk',
    );
    expect(screen.queryByRole('link', { name: /Call Hatti/ })).toBeNull();
    expect(screen.getByText(`Hatti answers ${HOURS.en}.`)).toBeTruthy();
    // What staff write to that number from their own mobile shows here too (ADR-561).
    expect(
      screen.getByText(/write to Hatti’s WhatsApp from your own verified mobile/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: '0300 1112233' }).getAttribute('href')).toBe(
      'https://wa.me/923001112233',
    );

    fireEvent.change(screen.getByLabelText('Search the help centre'), {
      target: { value: 'domain' },
    });
    expect(screen.getByText('Your own domain')).toBeTruthy();
    expect(screen.queryByText('Booking a courier')).toBeNull();

    fireEvent.change(screen.getByLabelText('About'), { target: { value: 'PAYMENTS' } });
    fireEvent.change(screen.getByLabelText('What do you need?'), {
      target: { value: 'JazzCash payments show as pending.' },
    });
    fireEvent.change(screen.getByLabelText('Mobile to call you back on (optional)'), {
      target: { value: '0300 1234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Hatti' }));
    expect(
      await screen.findByText('Sent. Hatti answers here within 8 working hours.'),
    ).toBeTruthy();
    expect(sentOf(fake, 'SupportRequestCreate')).toEqual([
      {
        input: {
          topic: 'PAYMENTS',
          message: 'JazzCash payments show as pending.',
          language: 'ENGLISH',
          callBack: '0300 1234567',
        },
      },
    ]);

    // Its requests, with Hatti's answers, closed when done.
    const requests = screen.getByRole('heading', { name: 'Your requests' }).parentElement!;
    expect(within(requests).getByText('PostEx fixed Multan; book again.')).toBeTruthy();
    expect(within(requests).getByText('Answer from Ayesha')).toBeTruthy();
    fireEvent.click(within(requests).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(sentOf(fake, 'SupportRequestClose')).toEqual([{ id: 'sreq_1' }]));
  });

  it('offers Free the help centre and requests alone, and says what the API refused', async () => {
    const fake = helpCore('FREE', {
      userErrors: [{ field: ['input', 'message'], code: 'INVALID', message: 'Say a little more' }],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/help');

    expect(
      await screen.findByText(
        'Free plan: the help centre and requests from here, answered within 48 working hours.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'WhatsApp Hatti' })).toBeNull();
    expect(screen.queryByText(/your own verified mobile/)).toBeNull();
    expect(
      screen.getByText('WhatsApp comes with Starter and up, and calls with Pro.'),
    ).toBeTruthy();

    const send = screen.getByRole('button', { name: 'Send to Hatti' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What do you need?'), { target: { value: 'help' } });
    fireEvent.change(screen.getByLabelText('Answer in'), { target: { value: 'ur' } });
    fireEvent.click(send);
    expect(await screen.findByText(/Say a little more/)).toBeTruthy();
    expect(sentOf(fake, 'SupportRequestCreate')[0]).toMatchObject({
      input: { language: 'URDU', callBack: null },
    });
  });

  it('shows a request written on WhatsApp as its thread, each message once (ADR-561)', async () => {
    vi.stubGlobal('fetch', helpCore('GROWTH', { userErrors: [] }, [onWhatsapp, answered]).fetcher);
    renderAdmin('/shop_1/help');

    const thread = await screen.findByRole('list', { name: 'On WhatsApp' });
    const request = thread.closest('li')!;
    const at = (iso: string) => formatDateTime(iso, 'Asia/Karachi', 'en');
    expect(within(request).getByText('Via WhatsApp')).toBeTruthy();
    // Its first message is the request's own: in the thread, not again above it.
    expect(within(request).getAllByText('Orders will not book for Multan.')).toHaveLength(1);

    const items = within(thread)
      .getAllByRole('listitem')
      .filter((each) => each.parentElement === thread);
    expect(items.map((each) => each.textContent)).toEqual([
      `You wrote${at('2026-10-16T05:00:00Z')}Orders will not book for Multan.`,
      `You wrote${at('2026-10-16T05:01:00Z')}PhotoIt is on the phone it was sent from: Hatti does not keep files.`,
      `You wrote${at('2026-10-16T05:02:00Z')}AttachmentIt is on the phone it was sent from: Hatti does not keep files.`,
      `Hatti${at('2026-10-16T05:30:00Z')}ReadWhich courier account?`,
      `You wrote${at('2026-10-16T05:40:00Z')}PostEx, the main one.`,
      // The answer, sent on WhatsApp: once, as the answer, with how it went.
      `Answer from Ayesha${at('2026-10-16T06:00:00Z')}On WhatsApp: DeliveredPostEx fixed Multan; book again.`,
      `Hatti${at('2026-10-17T09:00:00Z')}Not deliveredDid it work?More than 24 hours since you last wrote.`,
    ]);
    expect(within(request).getAllByText('PostEx fixed Multan; book again.')).toHaveLength(1);
    expect(within(request).getAllByText('Answer from Ayesha')).toHaveLength(1);

    // A request asked here, with no messages on WhatsApp, reads as it always has.
    const fromAdmin = screen.getByText('PostEx bookings fail for Multan.').closest('li')!;
    expect(fromAdmin).not.toBe(request);
    expect(within(fromAdmin).queryByText('Via WhatsApp')).toBeNull();
    expect(within(fromAdmin).queryByRole('list')).toBeNull();
    expect(within(fromAdmin).getByText('Answer from Ayesha')).toBeTruthy();
    expect(within(fromAdmin).queryByText(/On WhatsApp/)).toBeNull();
  });

  it('shows an answer not sent on WhatsApp after the thread, and the request’s words when the thread does not open with them', async () => {
    vi.stubGlobal(
      'fetch',
      helpCore('GROWTH', { userErrors: [] }, [
        {
          ...onWhatsapp,
          answer: 'Answered here alone.',
          messages: [onWhatsapp.messages[1], onWhatsapp.messages[6]],
        },
      ]).fetcher,
    );
    renderAdmin('/shop_1/help');

    const thread = await screen.findByRole('list', { name: 'On WhatsApp' });
    const request = thread.closest('li')!;
    expect(within(request).getByText('Orders will not book for Multan.')).toBeTruthy();
    expect(within(thread).getByText('Photo')).toBeTruthy();
    expect(within(thread).getByText('Not delivered')).toBeTruthy();
    expect(within(thread).queryByText('Answered here alone.')).toBeNull();
    expect(within(request).getByText('Answered here alone.')).toBeTruthy();
    expect(within(request).queryByText(/On WhatsApp:/)).toBeNull();
  });
});
