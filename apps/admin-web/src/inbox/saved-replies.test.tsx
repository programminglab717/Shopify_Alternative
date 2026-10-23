import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, press, renderAdmin, signedIn, type } from '../test-support';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A fake core with a conversation open to answer, and the shop's saved replies kept as it would. */
function repliesCore(role: StaffRole = 'confirmation_agent') {
  let next = 3;
  const kept = [
    { id: 'srep_1', title: 'Bank details', body: 'Meezan Bank\nIBAN PK36 MEZN 0001' },
    { id: 'srep_2', title: 'Delivery charges', body: 'Rs 200 across Pakistan' },
  ];
  const conversation = {
    id: 'conv_1',
    customerPhone: '+923001234567',
    viaOwnNumber: true,
    status: 'OPEN',
    unread: 0,
    lastMessageAt: ago(10),
    lastInboundAt: ago(10),
    replyableUntil: LATER,
    lastMessage: null,
    createdAt: ago(600),
  };
  const byTitle = () => kept.slice().sort((a, b) => a.title.localeCompare(b.title));
  const taken = (title: string, except: string | null) =>
    kept.some((each) => each.id !== except && each.title.toLowerCase() === title.toLowerCase());
  const refused = (title: string) => ({
    savedReply: null,
    userErrors: [
      { field: ['title'], code: 'TAKEN', message: `A saved reply is called ${title} already` },
    ],
  });

  return fakeCore(role, (operation, variables) => {
    // A query of no variables sends none.
    const input = variables?.input as { title: string; body: string } | undefined;
    switch (operation) {
      case 'SavedReplies':
        return { savedReplies: byTitle() };
      case 'SavedReplyCreate': {
        if (taken(input!.title, null)) return { savedReplyCreate: refused(input!.title) };
        const reply = { id: `srep_${next++}`, ...input! };
        kept.push(reply);
        return { savedReplyCreate: { savedReply: reply, userErrors: [] } };
      }
      case 'SavedReplyUpdate': {
        if (taken(input!.title, variables.id as string)) {
          return { savedReplyUpdate: refused(input!.title) };
        }
        const reply = kept.find((each) => each.id === variables.id)!;
        Object.assign(reply, input);
        return { savedReplyUpdate: { savedReply: reply, userErrors: [] } };
      }
      case 'SavedReplyDelete':
        kept.splice(
          kept.findIndex((each) => each.id === variables.id),
          1,
        );
        return { savedReplyDelete: { deletedSavedReplyId: variables.id, userErrors: [] } };
      case 'Conversation':
        return { conversation };
      case 'ConversationMessages':
        return {
          conversationMessages: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'ConversationReply':
        return {
          conversationReply: {
            conversation,
            message: {
              id: 'm9',
              direction: 'OUTBOUND',
              body: variables.body,
              mediaKind: null,
              at: ago(0),
              status: 'SENT',
              error: null,
            },
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (core: ReturnType<typeof repliesCore>, operation: string) =>
  core.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe("The inbox's saved replies, in the admin (MSG-06, ADR-758)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps, changes and deletes replies on their tab, refusing a title kept already', async () => {
    const core = repliesCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox?tab=replies');

    await screen.findByText('Delivery charges');
    expect(screen.getByText('2 saved replies')).toBeTruthy();

    type('Title', 'bank DETAILS');
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Again' } });
    await press('Keep the reply');
    await screen.findByText('A saved reply is called bank DETAILS already');
    type('Title', 'Measurements');
    fireEvent.change(screen.getByLabelText('Reply'), {
      target: { value: 'قمیض کی لمبائی اور چھاتی کا ناپ بھیجیں' },
    });
    await press('Keep the reply');
    await screen.findByText('3 saved replies');
    expect(sentOf(core, 'SavedReplyCreate').at(-1)).toEqual({
      input: { title: 'Measurements', body: 'قمیض کی لمبائی اور چھاتی کا ناپ بھیجیں' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Delivery charges' }));
    const titles = screen.getAllByLabelText('Title') as HTMLInputElement[];
    expect(titles.map((each) => each.value)).toContain('Delivery charges');
    fireEvent.change(
      titles.find((each) => each.value === 'Delivery charges')!,
      {
        target: { value: 'Delivery' },
      },
    );
    await press('Save');
    await screen.findByText('Delivery');
    expect(sentOf(core, 'SavedReplyUpdate')).toEqual([
      { id: 'srep_2', input: { title: 'Delivery', body: 'Rs 200 across Pakistan' } },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Bank details' }));
    await press('Keep it');
    expect(sentOf(core, 'SavedReplyDelete')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Bank details' }));
    expect(screen.getByText('Delete Bank details?')).toBeTruthy();
    await press('Delete');
    await screen.findByText('2 saved replies');
    expect(sentOf(core, 'SavedReplyDelete')).toEqual([{ id: 'srep_1' }]);
  });

  it('puts a saved reply found by its words in the answer, to change before sending; marketers only read them', async () => {
    const core = repliesCore();
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/inbox/conv_1');

    const answer = (await screen.findByLabelText('Reply')) as HTMLTextAreaElement;
    await press('Saved replies');
    type('Find a saved reply', 'iban');
    await screen.findByText('Bank details');
    expect(screen.queryByText('Delivery charges')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Bank details/ }));
    expect(answer.value).toBe('Meezan Bank\nIBAN PK36 MEZN 0001');
    // Another goes after what is written.
    await press('Saved replies');
    fireEvent.click(await screen.findByRole('button', { name: /^Delivery charges/ }));
    expect(answer.value).toBe('Meezan Bank\nIBAN PK36 MEZN 0001\nRs 200 across Pakistan');
    await press('Send');
    await waitFor(() =>
      expect(sentOf(core, 'ConversationReply')).toEqual([
        { id: 'conv_1', body: 'Meezan Bank\nIBAN PK36 MEZN 0001\nRs 200 across Pakistan' },
      ]),
    );
    cleanup();

    vi.stubGlobal('fetch', repliesCore('marketer').fetcher);
    renderAdmin('/shop_1/inbox?tab=replies');
    await screen.findByText('Delivery charges');
    expect(screen.queryByText('New saved reply')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Delivery charges' })).toBeNull();
  });
});
