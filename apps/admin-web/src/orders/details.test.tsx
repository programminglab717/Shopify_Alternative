import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, LATER, renderAdmin, signedIn, type } from '../test-support';

const rupees = (amount: string) => ({ amount, currencyCode: 'PKR' });

const comment = (id: string, authorId: string, name: string, message: string) => ({
  id,
  kind: 'comment',
  message,
  createdAt: LATER,
  editedAt: null,
  author: { id: authorId, name },
});

function order(extra: Record<string, unknown> = {}) {
  return {
    shop: { timezone: 'Asia/Karachi' },
    order: {
      id: 'ord_7',
      name: '#1007',
      createdAt: LATER,
      stage: 'TO_PACK',
      status: 'OPEN',
      paymentMethod: 'CASH_ON_DELIVERY',
      financialStatus: 'PENDING',
      confirmationStatus: 'CONFIRMED',
      cancelReason: null,
      overPlanLimit: false,
      note: 'Call before 6 pm',
      tags: ['eid'],
      phone: '+923001234567',
      email: null,
      source: 'WEB',
      lineItems: [],
      subtotalPrice: rupees('7500'),
      totalShippingPrice: rupees('200'),
      totalDiscounts: rupees('0'),
      codFee: rupees('0'),
      totalPrice: rupees('7700'),
      amountPaid: rupees('0'),
      codAmount: rupees('7700'),
      customer: null,
      shippingAddress: {
        name: 'Ayesha Khan',
        phone: '+923001234567',
        address1: 'House 4, Street 9',
        address2: 'Gulberg III',
        landmark: null,
        city: 'Lahore',
        province: 'Punjab',
        zip: '54660',
        formatted: ['Ayesha Khan', 'House 4, Street 9', 'Gulberg III', 'Lahore, Punjab 54660'],
      },
      risk: null,
      assignee: null,
      amountRefunded: rupees('0'),
      advanceDue: rupees('0'),
      transferReceipts: [],
      customerLink: null,
      refunds: [],
      fulfillments: [],
      returns: [],
      events: {
        nodes: [
          comment('ocm_1', 'usr_1', 'Sana', 'Customer wants it after Eid'),
          comment('ocm_2', 'usr_2', 'Bilal', 'Asked for gift wrap'),
          {
            id: 'oev_1',
            kind: 'confirmed',
            message: 'Confirmed by the customer',
            createdAt: LATER,
            editedAt: null,
            author: null,
          },
        ],
      },
      ...extra,
    },
  };
}

const ok = (field: string) => ({ [field]: { userErrors: [] } });

function core(role: StaffRole, answer = order()) {
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'Order':
        return answer;
      case 'Staff':
        return {
          staffMembers: [
            { id: 'usr_1', name: 'Sana', email: null, role: 'OWNER', joinedAt: LATER },
            { id: 'usr_2', name: 'Bilal', email: null, role: 'PACKER', joinedAt: LATER },
          ],
          staffInvitations: [],
        };
      case 'OrderAssign':
        return ok('orderAssign');
      case 'OrderCommentCreate':
        return ok('orderCommentCreate');
      case 'OrderCommentUpdate':
        return ok('orderCommentUpdate');
      case 'OrderCommentDelete':
        return ok('orderCommentDelete');
      case 'OrderUpdate':
        return ok('orderUpdate');
      case 'Messages':
        return {
          messages: {
            nodes: [
              {
                id: 'msg_1',
                kind: 'ORDER_CONFIRMATION_REMINDER',
                channel: 'WHATSAPP',
                status: 'DELIVERED',
                recipient: '+92300*****67',
                orderId: 'ord_7',
                error: null,
                attempts: 1,
                createdAt: LATER,
                sentAt: LATER,
                deliveredAt: LATER,
                readAt: null,
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).at(-1)?.variables;

describe("An order's everyday edits, on its page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets an agent take an order no one has, comment, and change only their own comment', async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const who = await screen.findByRole('region', { name: 'Who sees it through' });
    expect(within(who).getByText('No one has it yet.')).toBeTruthy();
    fireEvent.click(within(who).getByRole('button', { name: 'Take it' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderAssign')).toEqual({ id: 'ord_7', staffMemberId: 'usr_1' }),
    );

    const timeline = screen.getByRole('region', { name: 'Timeline' });
    type('Comment', '@Bilal please pack it with the dupatta');
    fireEvent.click(within(timeline).getByRole('button', { name: 'Add the comment' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderCommentCreate')).toEqual({
        orderId: 'ord_7',
        message: '@Bilal please pack it with the dupatta',
      }),
    );

    // Sana's own comment can be changed and deleted; Bilal's cannot, by an agent.
    expect(within(timeline).getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(within(timeline).getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    fireEvent.click(within(timeline).getByRole('button', { name: 'Edit' }));
    const editing = within(timeline).getAllByLabelText('Comment')[1] as HTMLTextAreaElement;
    expect(editing.value).toBe('Customer wants it after Eid');
    fireEvent.change(editing, { target: { value: 'Customer wants it on the 2nd day of Eid' } });
    fireEvent.click(within(timeline).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderCommentUpdate')).toEqual({
        id: 'ocm_1',
        message: 'Customer wants it on the 2nd day of Eid',
      }),
    );
  });

  it('lets an owner give the order to anyone, or no one, and delete any comment', async () => {
    const fake = core('owner', order({ assignee: { id: 'usr_2', name: 'Bilal' } }));
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const given = (await screen.findByLabelText('Given to')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'Sana (you)' });
    expect(given.value).toBe('usr_2');
    fireEvent.change(given, { target: { value: 'usr_1' } });
    await waitFor(() =>
      expect(sentOf(fake, 'OrderAssign')).toEqual({ id: 'ord_7', staffMemberId: 'usr_1' }),
    );
    fireEvent.change(given, { target: { value: '' } });
    await waitFor(() =>
      expect(sentOf(fake, 'OrderAssign')).toEqual({ id: 'ord_7', staffMemberId: null }),
    );

    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(within(timeline).getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    fireEvent.click(within(timeline).getAllByRole('button', { name: 'Delete' })[1]!);
    await waitFor(() => expect(sentOf(fake, 'OrderCommentDelete')).toEqual({ id: 'ocm_2' }));
  });

  it("changes the order's note and tags, and corrects its address before it ships", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const notes = await screen.findByRole('region', { name: 'Note and tags' });
    expect(within(notes).getByText('Call before 6 pm')).toBeTruthy();
    fireEvent.click(within(notes).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(notes).getByLabelText('Note'), {
      target: { value: 'Call after 6 pm' },
    });
    fireEvent.change(within(notes).getByLabelText('Tags'), { target: { value: 'eid, gift' } });
    fireEvent.click(within(notes).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderUpdate')).toEqual({
        id: 'ord_7',
        input: { note: 'Call after 6 pm', tags: ['eid', 'gift'] },
      }),
    );

    const address = screen.getByRole('region', { name: 'Delivery address' });
    fireEvent.click(within(address).getByRole('button', { name: 'Correct the address' }));
    expect((within(address).getByLabelText('House and street') as HTMLInputElement).value).toBe(
      'House 4, Street 9',
    );
    fireEvent.change(within(address).getByLabelText('House and street'), {
      target: { value: 'House 14, Street 9' },
    });
    fireEvent.change(within(address).getByLabelText('Landmark'), {
      target: { value: 'near Liberty Market' },
    });
    fireEvent.click(within(address).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sentOf(fake, 'OrderUpdate')).toEqual({
        id: 'ord_7',
        input: {
          shippingAddress: {
            name: 'Ayesha Khan',
            phone: '+923001234567',
            address1: 'House 14, Street 9',
            address2: 'Gulberg III',
            landmark: 'near Liberty Market',
            city: 'Lahore',
            province: 'Punjab',
            zip: '54660',
          },
        },
      }),
    );
  });

  it('leaves the address as it is once a parcel shipped, and edits to those who work orders', async () => {
    vi.stubGlobal(
      'fetch',
      core(
        'accountant',
        order({
          fulfillments: [
            {
              id: 'ful_1',
              status: 'IN_TRANSIT',
              shippedAt: LATER,
              deliveredAt: null,
              returningAt: null,
              returnedAt: null,
              lostAt: null,
              trackingInfo: { company: 'TCS', number: '779', url: null },
              fulfillmentLineItems: [],
              events: { nodes: [] },
              claim: null,
            },
          ],
        }),
      ).fetcher,
    );
    renderAdmin('/shop_1/orders/ord_7');

    await screen.findByRole('region', { name: 'Delivery address' });
    expect(screen.queryByRole('button', { name: 'Correct the address' })).toBeNull();
    expect(screen.queryByLabelText('Comment')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take it' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('shows what its customer was told, once asked', async () => {
    const fake = core('confirmation_agent');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/orders/ord_7');

    const messages = await screen.findByRole('region', { name: 'Messages' });
    expect(fake.sent.some((each) => each.operation === 'Messages')).toBe(false);
    fireEvent.click(within(messages).getByRole('button', { name: 'Show the messages sent' }));
    expect(await within(messages).findByText('Reminder to confirm')).toBeTruthy();
    expect(within(messages).getByText('Delivered')).toBeTruthy();
    expect(within(messages).queryByRole('link', { name: 'Its order' })).toBeNull();
    expect(fake.sent.filter((each) => each.operation === 'Messages').at(-1)?.variables).toEqual({
      orderId: 'ord_7',
      status: null,
    });
  });
});
