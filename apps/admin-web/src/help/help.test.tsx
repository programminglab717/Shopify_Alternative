import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sectionsOf } from '../shell/shell';
import { fakeCore, renderAdmin, signedIn } from '../test-support';
import { HELP_ARTICLES, searchArticles } from './articles';

const HOURS = { en: 'Monday to Saturday, 10am to 7pm', ur: 'پیر سے ہفتہ، صبح 10 سے شام 7' };

const answered = {
  id: 'sreq_1',
  topic: 'COURIERS',
  message: 'PostEx bookings fail for Multan.',
  callBack: null,
  status: 'ANSWERED',
  answer: 'PostEx fixed Multan; book again.',
  answeredBy: 'Ayesha',
  answeredAt: '2026-10-16T09:00:00Z',
  createdAt: '2026-10-16T07:00:00Z',
};

const support = (plan: string, extra: object = {}) => ({
  hattiSupport: {
    plan,
    channel: plan === 'FREE' ? 'HELP_CENTRE' : 'PRIORITY_WHATSAPP',
    answerWithinHours: plan === 'FREE' ? 48 : 8,
    whatsapp: plan === 'FREE' ? null : '+923001112233',
    phone: null,
    email: 'help@hatti.pk',
    hours: HOURS,
    requests: [answered],
    ...extra,
  },
});

function helpCore(plan = 'GROWTH', created: object = { userErrors: [] }) {
  return fakeCore('packer', (operation, variables) => {
    switch (operation) {
      case 'HattiSupport':
        return support(plan);
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
});
