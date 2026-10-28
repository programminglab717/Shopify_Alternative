import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserError } from '../api/types';
import type { StaffRole } from '../auth/session';
import { sectionsOf } from '../shell/shell';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function message(
  id: string,
  direction: 'INBOUND' | 'OUTBOUND',
  body: string | null,
  extra: object = {},
) {
  return {
    id,
    direction,
    body,
    mediaKind: null as string | null,
    at: ago(60),
    status: direction === 'OUTBOUND' ? 'SENT' : null,
    error: null as string | null,
    ...extra,
  };
}

type Message = ReturnType<typeof message>;

function conversation(id: string, customerPhone: string, extra: object = {}) {
  return {
    id,
    customerPhone,
    viaOwnNumber: true,
    status: 'OPEN',
    unread: 0,
    lastMessageAt: ago(10),
    lastInboundAt: ago(10),
    replyableUntil: LATER,
    lastMessage: null as Message | null,
    createdAt: ago(600),
    labels: [] as string[],
    ...extra,
  };
}

/** The first conversation's messages, the oldest first. */
const THREAD = [
  message('m1', 'INBOUND', 'Salam, is the lawn suit in stock?'),
  message('m2', 'OUTBOUND', 'Walaikum salam, which colour?', {
    status: 'FAILED',
    error: 'Message undeliverable',
  }),
  message('m3', 'OUTBOUND', 'We have it in green and blue', { status: 'READ', byAi: true }),
  message('m4', 'INBOUND', null, { mediaKind: 'image' }),
  message('m5', 'INBOUND', null, { mediaKind: 'contacts' }),
  message('m6', 'INBOUND', 'Green please'),
];

/**
 * A fake core with four conversations, three open and one closed, answered two at a time, and the
 * first's messages four at a time: reading, closing and replying change them as the core would.
 */
function inboxCore(
  role: StaffRole = 'owner',
  {
    phone = '+923001234567',
    replyableUntil = LATER,
    replyErrors = [],
    empty = false,
    web = false,
  }: {
    phone?: string;
    replyableUntil?: string;
    /** What the core refuses each reply with, in turn; a reply past them is sent. */
    replyErrors?: UserError[][];
    empty?: boolean;
    /** The first written in the chat on the online store (ADR-810), answered at any time. */
    web?: boolean;
  } = {},
) {
  const thread = THREAD.map((each) => ({ ...each }));
  const conversations = empty
    ? []
    : [
        conversation('conv_1', phone, {
          unread: 2,
          replyableUntil: web ? null : replyableUntil,
          lastMessage: thread.at(-1)!,
          ...(web && { channel: 'WEB', customerName: 'Ayesha Khan' }),
        }),
        conversation('conv_2', '+923211234567', {
          viaOwnNumber: false,
          lastMessage: message('x', 'OUTBOUND', 'Your parcel left today'),
        }),
        conversation('conv_3', '+923331234567', {
          lastMessage: message('y', 'INBOUND', null, { mediaKind: 'audio' }),
        }),
        conversation('conv_4', '+923451234567', {
          status: 'CLOSED',
          lastMessage: message('z', 'INBOUND', 'Shukriya'),
        }),
      ];
  const find = (id: unknown) => conversations.find((each) => each.id === id) ?? null;
  let replies = 0;

  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Conversations': {
        const shown = conversations.filter(
          (each) =>
            (!variables.status || each.status === variables.status) &&
            (!variables.unread || each.unread > 0),
        );
        const start = variables.after ? Number(String(variables.after).slice(4)) : 0;
        return {
          conversations: {
            nodes: shown.slice(start, start + 2),
            pageInfo: { hasNextPage: start + 2 < shown.length, endCursor: `cur_${start + 2}` },
          },
          conversationsUnreadCount: conversations.filter((each) => each.unread > 0).length,
        };
      }
      case 'Conversation':
        return { conversation: find(variables.id) };
      case 'ConversationMessages': {
        const latestFirst = thread.slice().reverse();
        const from = variables.before
          ? latestFirst.findIndex((each) => each.id === variables.before) + 1
          : 0;
        const nodes = latestFirst.slice(from, from + 4);
        return {
          conversationMessages: {
            nodes,
            pageInfo: {
              hasNextPage: from + 4 < latestFirst.length,
              endCursor: nodes.at(-1)?.id ?? null,
            },
          },
        };
      }
      case 'ConversationMarkRead': {
        const found = find(variables.id)!;
        found.unread = 0;
        return { conversationMarkRead: { conversation: found, userErrors: [] } };
      }
      case 'ConversationUpdateStatus': {
        const found = find(variables.id)!;
        found.status = variables.status as string;
        if (found.status === 'CLOSED') found.unread = 0;
        return { conversationUpdateStatus: { conversation: found, userErrors: [] } };
      }
      case 'ConversationReply': {
        const found = find(variables.id)!;
        const refused = replyErrors[replies++];
        if (refused) {
          return { conversationReply: { conversation: null, message: null, userErrors: refused } };
        }
        const sent = message(`r${replies}`, 'OUTBOUND', variables.body as string, { at: ago(0) });
        thread.push(sent);
        found.lastMessage = sent;
        return { conversationReply: { conversation: found, message: sent, userErrors: [] } };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof inboxCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('The inbox: customers’ WhatsApp conversations (MSG-05, ADR-545)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is for those who read conversations; packers and accountants see none', () => {
    for (const role of ['owner', 'manager', 'confirmation_agent', 'marketer'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/inbox')).toBe(true);
    }
    for (const role of ['packer', 'accountant'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/inbox')).toBe(false);
    }
  });

  it('lists the open conversations a page at a time, then those unread and those closed', async () => {
    const core = inboxCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox');

    expect(await screen.findByText('0300 1234567')).toBeTruthy();
    expect(screen.getByText(/1 conversation unread/)).toBeTruthy();
    expect(screen.getByText('Green please')).toBeTruthy();
    expect(screen.getByText('2 unread')).toBeTruthy();
    // The shop's own last words are marked so, and Hatti's shared number is named.
    expect(screen.getByText('You: Your parcel left today')).toBeTruthy();
    expect(screen.getByText("Hatti's number")).toBeTruthy();
    expect(screen.queryByText('0333 1234567')).toBeNull();

    await press('Show more');
    // What the customer sent besides words is named.
    expect(await screen.findByText('Voice note')).toBeTruthy();
    expect(screen.getByText('0333 1234567')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(sentOf(core, 'Conversations')).toEqual([
      {
        first: 50,
        after: null,
        status: 'OPEN',
        unread: null,
        assignedToMe: null,
        overdue: null,
        label: null,
      },
      {
        first: 50,
        after: 'cur_2',
        status: 'OPEN',
        unread: null,
        assignedToMe: null,
        overdue: null,
        label: null,
      },
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(await screen.findByText('0300 1234567')).toBeTruthy();
    expect(screen.queryByText('0321 1234567')).toBeNull();
    expect(sentOf(core, 'Conversations').at(-1)).toEqual({
      first: 50,
      after: null,
      status: null,
      unread: true,
      assignedToMe: null,
      overdue: null,
      label: null,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(await screen.findByText('Shukriya')).toBeTruthy();
    expect(screen.queryByText('0300 1234567')).toBeNull();
    expect(screen.getByRole('link', { name: /0345 1234567/ }).getAttribute('href')).toBe(
      '/shop_1/inbox/conv_4',
    );
  });

  it('says when a tab has no conversations', async () => {
    vi.stubGlobal('fetch', inboxCore('owner', { empty: true }).fetcher);
    renderAdmin('/shop_1/inbox');

    expect(await screen.findByText('No conversations waiting')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    expect(await screen.findByText('Nothing unread')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(await screen.findByText('No closed conversations')).toBeTruthy();
  });

  it('marks a conversation read as a writer opens it, the oldest message at the top', async () => {
    const core = inboxCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox');

    fireEvent.click(await screen.findByRole('link', { name: /0300 1234567/ }));
    expect(await screen.findByRole('heading', { name: /0300 1234567/ })).toBeTruthy();
    expect(screen.getByText('Writes to your own WhatsApp number')).toBeTruthy();
    await waitFor(() => expect(sentOf(core, 'ConversationMarkRead')).toEqual([{ id: 'conv_1' }]));
    await waitFor(() => expect(screen.queryByText('2 unread')).toBeNull());

    // The latest four first, older ones on request; what the customer sent besides words is named
    // and is on their phone; how each reply went.
    expect(await screen.findByText('Green please')).toBeTruthy();
    expect(screen.getByText('Photo')).toBeTruthy();
    expect(screen.getByText('Attachment')).toBeTruthy();
    expect(
      screen.getAllByText("It is on the customer's phone: Hatti does not keep files."),
    ).toHaveLength(2);
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.queryByText('Salam, is the lawn suit in stock?')).toBeNull();

    await press('Load older messages');
    expect(await screen.findByText('Salam, is the lawn suit in stock?')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Message undeliverable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
    expect(sentOf(core, 'ConversationMessages').at(-1)).toEqual({
      conversationId: 'conv_1',
      first: 50,
      before: 'm3',
    });
    const thread = screen.getByText('Green please').closest('ol')!;
    const bodies = within(thread)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('p')?.textContent ?? null);
    expect(bodies).toEqual([
      'Salam, is the lawn suit in stock?',
      'Walaikum salam, which colour?',
      'We have it in green and blue',
      null,
      null,
      'Green please',
    ]);
    // The AI's answer says it is the AI's (ADR-849); staff's don't.
    const items = within(thread).getAllByRole('listitem');
    expect(within(items[2]!).getByText('AI')).toBeTruthy();
    expect(within(items[1]!).queryByText('AI')).toBeNull();
    expect(sentOf(core, 'ConversationMarkRead')).toHaveLength(1);
  });

  it('shows a marketer the conversation alone: not read for them, closed or answered', async () => {
    const core = inboxCore('marketer', { phone: '0300 ••••567' });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    expect(await screen.findByText('Green please')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /0300 ••••567/ })).toBeTruthy();
    expect(screen.getByText('2 unread')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByLabelText('Reply')).toBeNull();
    expect(screen.queryByText(/WhatsApp lets a shop answer/)).toBeNull();
    expect(sentOf(core, 'ConversationMarkRead')).toEqual([]);
  });

  it('sends the reply trimmed and shows it in the thread', async () => {
    const core = inboxCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    await screen.findByText('Green please');
    const words = 'Ji, green kal tak pohnch jaye ga';
    type('Reply', `  ${words}  `);
    expect(screen.getByText(`${words.length} of 4,096 characters`)).toBeTruthy();
    await press('Send');

    expect(await screen.findByText(words)).toBeTruthy();
    expect(sentOf(core, 'ConversationReply')).toEqual([{ id: 'conv_1', body: words }]);
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getAllByText('Sent').length).toBeGreaterThan(0);
  });

  it('says why WhatsApp would not take a reply', async () => {
    const core = inboxCore('confirmation_agent', {
      replyErrors: [
        [{ field: ['body'], code: 'NOT_SENT', message: 'Recipient phone number not on WhatsApp' }],
        [{ field: ['id'], code: 'WINDOW_CLOSED', message: 'Past the day' }],
      ],
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    await screen.findByText('Green please');
    type('Reply', 'Aap ka order confirm hai');
    await press('Send');
    expect(
      await screen.findByText(
        'WhatsApp would not send this: Recipient phone number not on WhatsApp',
      ),
    ).toBeTruthy();
    // What was written stays, to send again.
    expect((screen.getByLabelText('Reply') as HTMLTextAreaElement).value).toBe(
      'Aap ka order confirm hai',
    );

    await press('Send');
    expect(
      await screen.findByText(
        'The day WhatsApp allows for answering has passed. You can answer once the customer writes again.',
      ),
    ).toBeTruthy();
    expect(sentOf(core, 'ConversationReply')).toHaveLength(2);
  });

  it('offers no reply box once the day WhatsApp allows has passed', async () => {
    vi.stubGlobal('fetch', inboxCore('owner', { replyableUntil: ago(5) }).fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    expect(
      await screen.findByText(
        "WhatsApp lets a shop answer in its own words only within a day of the customer's last message. To reach them now, send one of your shop's WhatsApp templates.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Reply')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('shows a chat from the online store by the name given, answered at any time (ADR-812)', async () => {
    const core = inboxCore('owner', { web: true });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox');
    const item = (await screen.findByText(/^Ayesha Khan · /)).closest('a')!;
    expect(within(item).getByText('Web chat')).toBeTruthy();

    cleanup();
    renderAdmin('/shop_1/inbox/conv_1');
    expect(
      await screen.findByText(
        'Wrote in the chat on your online store. Answer here at any time: they read it when they open the chat again.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Ayesha Khan · /);
    // No day to answer within, and nothing said of one.
    expect(screen.queryByText(/You can answer in your own words until/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Yes, in medium' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(sentOf(core, 'ConversationReply')).toEqual([{ id: 'conv_1', body: 'Yes, in medium' }]),
    );
  });

  it('closes a conversation and opens it again', async () => {
    const core = inboxCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    await screen.findByText('Green please');
    await press('Close');
    expect(
      await screen.findByText('Closed. It opens again when the customer writes.'),
    ).toBeTruthy();
    await press('Reopen');
    await waitFor(() =>
      expect(screen.queryByText('Closed. It opens again when the customer writes.')).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(sentOf(core, 'ConversationUpdateStatus')).toEqual([
      { id: 'conv_1', status: 'CLOSED' },
      { id: 'conv_1', status: 'OPEN' },
    ]);
  });
});

function contactMessage(id: string, extra: object = {}) {
  return {
    id,
    name: 'Ayesha Khan' as string | null,
    email: null as string | null,
    phone: '+923001234567' as string | null,
    body: 'Is the lawn suit back in medium?',
    fields: [] as { name: string; value: string }[],
    page: '/pages/contact' as string | null,
    language: 'en',
    receivedAt: ago(30),
    readAt: null as string | null,
    ...extra,
  };
}

/** A fake core with the contact form's messages: marking and deleting change them as it would. */
function contactCore(role: StaffRole = 'owner', empty = false) {
  const messages = empty
    ? []
    : [
        contactMessage('cform_1', { fields: [{ name: 'Order number', value: '#1042' }] }),
        contactMessage('cform_2', {
          name: null,
          phone: role === 'marketer' ? '0321 ••••567' : null,
          email: 'bilal@example.pk',
          body: 'Do you deliver to Quetta?',
          readAt: ago(5),
        }),
      ];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'ContactMessages':
        return {
          contactMessages: {
            nodes: messages,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          contactMessagesUnreadCount: messages.filter((each) => each.readAt === null).length,
        };
      case 'ContactMessageMarkRead': {
        const found = messages.find((each) => each.id === variables.id)!;
        found.readAt = variables.read ? ago(0) : null;
        return { contactMessageMarkRead: { contactMessage: found, userErrors: [] } };
      }
      case 'ContactMessageDelete': {
        messages.splice(
          messages.findIndex((each) => each.id === variables.id),
          1,
        );
        return {
          contactMessageDelete: { deletedContactMessageId: variables.id, userErrors: [] },
        };
      }
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe("The inbox's contact form tab (OS-08, ADR-590)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists what shoppers wrote with how to answer them, marked read and deleted by those who work the inbox', async () => {
    const core = contactCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox?tab=form');

    expect(await screen.findByText('Is the lawn suit back in medium?')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Contact form' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('Ayesha Khan')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByRole('link', { name: '0300 1234567' }).getAttribute('href')).toBe(
      'tel:+923001234567',
    );
    expect(screen.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toBe(
      'https://wa.me/923001234567',
    );
    expect(screen.getByText('Order number')).toBeTruthy();
    expect(screen.getByText('#1042')).toBeTruthy();
    expect(screen.getAllByText('Sent from /pages/contact')).toHaveLength(2);
    // One with an email alone and no name.
    expect(screen.getByText('No name given')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'bilal@example.pk' }).getAttribute('href')).toBe(
      'mailto:bilal@example.pk',
    );

    await press('Mark as read');
    await waitFor(() =>
      expect(sentOf(core, 'ContactMessageMarkRead')).toEqual([{ id: 'cform_1', read: true }]),
    );
    expect(await screen.findAllByRole('button', { name: 'Mark as unread' })).toHaveLength(2);

    const second = screen.getByText('Do you deliver to Quetta?').closest('li')!;
    fireEvent.click(within(second).getByRole('button', { name: 'Delete' }));
    expect(within(second).getByText('Delete this message for good?')).toBeTruthy();
    fireEvent.click(within(second).getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(sentOf(core, 'ContactMessageDelete')).toEqual([{ id: 'cform_2' }]));
    await waitFor(() => expect(screen.queryByText('Do you deliver to Quetta?')).toBeNull());
  });

  it('shows a marketer the messages alone, numbers masked and nothing to dial', async () => {
    const core = contactCore('marketer');
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox?tab=form');

    expect(await screen.findByText('Do you deliver to Quetta?')).toBeTruthy();
    expect(screen.getByText('0321 ••••567')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '0321 ••••567' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as read' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('says when no shopper has written', async () => {
    vi.stubGlobal('fetch', contactCore('owner', true).fetcher);
    renderAdmin('/shop_1/inbox?tab=form');
    expect(await screen.findByText('No messages from the contact form')).toBeTruthy();
  });
});
