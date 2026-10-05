import 'reflect-metadata';
import type { StaffRole, TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId, toPublicId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toOrderEventConnection } from './graphql/mappers.js';
import { mentionsIn, staffAlertFactsIn } from './staff-alerts.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Comments on an order's timeline", () => {
  let f: OrdersFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await ordersFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    [kurta] = (await f.variantsOf(f.a, 'Kurta')) as [string];
  });

  const staff = (role: StaffRole, userId: string = newId()): TenantContext => ({
    ...f.a,
    actor: { kind: 'staff', userId, sessionId: newId(), authenticatedAt: new Date(), role },
  });

  it('keeps comments among what happened to the order, newest first', async () => {
    const order = await f.order(f.a, [kurta]);
    const agentId = newId();
    const agent = staff('confirmation_agent', agentId);
    const first = unwrap(
      await f.comments.create(agent, order.id, '  Call after 5pm; she works mornings  '),
    );
    expect(first).toMatchObject({
      kind: 'comment',
      message: 'Call after 5pm; she works mornings',
      comment: true,
      actorKind: 'staff',
      actorId: agentId,
      editedAt: null,
    });
    unwrap(await f.orders.confirm(f.a, order.id));
    expect(unwrap(await f.comments.create(f.a, order.id, 'Booked with TCS'))).toMatchObject({
      actorKind: 'app',
      actorId: (f.a.actor as { tokenId: string }).tokenId,
    });

    const timeline = await f.orders.timeline(f.a, order.id, { first: 10 });
    expect(timeline.items.map((entry) => [entry.kind, entry.comment, entry.message])).toEqual([
      ['comment', true, 'Booked with TCS'],
      ['confirmed', false, 'Confirmed by the customer'],
      ['comment', true, 'Call after 5pm; she works mornings'],
      ['created', false, 'Order #1001 placed through the API: Rs 1,000, cash on delivery'],
    ]);
    // A page at a time, across both.
    const page = await f.orders.timeline(f.a, order.id, { first: 2 });
    expect(page.hasNextPage).toBe(true);
    const next = await f.orders.timeline(f.a, order.id, { first: 2, after: page.items[1]!.id });
    expect([next.items.map((entry) => entry.kind), next.hasNextPage]).toEqual([
      ['comment', 'created'],
      false,
    ]);
    // Comments' IDs are their own kind.
    expect(toOrderEventConnection(timeline.items, false).nodes.map((node) => node.id)).toEqual([
      expect.stringMatching(/^ocm_/),
      expect.stringMatching(/^oev_/),
      toPublicId('orderComment', first.id),
      expect.stringMatching(/^oev_/),
    ]);

    // A comment changes nothing of the order, not its version: it is an event of its own, which
    // says which comment, never what it says (ADR-191).
    expect((await f.orders.get(f.a, order.id))!.version).toBe(2);
    const events = (await f.outbox()).filter((event) => event.event_type.startsWith('order'));
    expect(events.map((event) => event.event_type)).toEqual([
      'order.created',
      'order_comment.created',
      'order.confirmed',
      'order_comment.created',
    ]);
    expect(events[1]).toEqual({
      event_type: 'order_comment.created',
      aggregate_id: first.id,
      payload: { orderId: order.id },
    });

    // Words it takes, on orders it finds.
    expect(errorsOf(await f.comments.create(agent, order.id, '   '))).toEqual([
      ['message', 'BLANK'],
    ]);
    expect(errorsOf(await f.comments.create(agent, order.id, 'x'.repeat(2_001)))).toEqual([
      ['message', 'TOO_LONG'],
    ]);
    expect(errorsOf(await f.comments.create(agent, newId(), 'Hello'))).toEqual([
      ['orderId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.comments.create(f.b, order.id, 'Hello'))).toEqual([
      ['orderId', 'NOT_FOUND'],
    ]);
  });

  it('lets authors change and delete their comments, and owners and managers delete any', async () => {
    const order = await f.order(f.a, [kurta]);
    const agentId = newId();
    const agent = staff('confirmation_agent', agentId);
    const comment = unwrap(await f.comments.create(agent, order.id, 'Wants it gift wrapped'));
    const updates = async () =>
      (await f.outbox()).filter((event) => event.event_type === 'order_comment.updated').length;

    // Its author changes it, from any of their sessions; the same words again change nothing.
    const edited = unwrap(
      await f.comments.update(
        staff('confirmation_agent', agentId),
        comment.id,
        'Wants it gift wrapped, in red',
      ),
    );
    expect(edited).toMatchObject({
      id: comment.id,
      message: 'Wants it gift wrapped, in red',
      editedAt: expect.any(Date),
    });
    expect(
      unwrap(await f.comments.update(agent, comment.id, 'Wants it gift wrapped, in red')).editedAt,
    ).toEqual(edited.editedAt);
    expect(await updates()).toBe(1);
    expect((await f.orders.timeline(f.a, order.id, { first: 1 })).items[0]).toMatchObject({
      message: 'Wants it gift wrapped, in red',
      editedAt: edited.editedAt,
    });

    // No one else changes it, an owner or manager neither; they delete it, as its author does.
    const packer = staff('packer');
    for (const someone of [packer, staff('owner'), f.a]) {
      expect(errorsOf(await f.comments.update(someone, comment.id, 'Not gift wrapped'))).toEqual([
        ['id', 'INVALID'],
      ]);
    }
    expect(errorsOf(await f.comments.delete(packer, comment.id, { anyones: false }))).toEqual([
      ['id', 'INVALID'],
    ]);
    expect(
      unwrap(await f.comments.delete(staff('manager'), comment.id, { anyones: true })),
    ).toEqual({ orderId: order.id });
    expect(errorsOf(await f.comments.delete(agent, comment.id, { anyones: false }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    const apps = unwrap(await f.comments.create(f.a, order.id, 'Synced to the warehouse'));
    unwrap(await f.comments.delete(f.a, apps.id, { anyones: false }));
    expect(
      (await f.orders.timeline(f.a, order.id, { first: 10 })).items.map((entry) => entry.kind),
    ).toEqual(['created']);

    // Another shop finds none of them.
    const mine = unwrap(await f.comments.create(agent, order.id, 'Ours'));
    expect(errorsOf(await f.comments.update(f.b, mine.id, 'Theirs'))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.comments.delete(f.b, mine.id, { anyones: true }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
  });

  it('finds the staff a comment names, and what their alerts say of it (ADR-191)', async () => {
    const members = [
      { userId: 'ali', name: 'Ali' },
      { userId: 'ali-raza', name: 'Ali  Raza' },
      { userId: 'ayesha', name: 'Ayesha Khan' },
      { userId: 'ayesha-too', name: 'ayesha khan' },
      { userId: 'sana', name: 'ثناء' },
    ];
    // The longest name that fits, in any case or spacing, in the order first named.
    expect(mentionsIn('@ali raza please call her; @Ali too, and @ali raza again', members)).toEqual(
      ['ali-raza', 'ali'],
    );
    // Members with the same name are each named, whatever its spelling.
    expect(mentionsIn('@AYESHA   KHAN packed it', members)).toEqual(['ayesha', 'ayesha-too']);
    expect(mentionsIn('@ثناء دیکھ لیں', members)).toEqual(['sana']);
    expect(mentionsIn('(@Ali) knows.', members)).toEqual(['ali']);
    // Not within an address, a longer word, or apart from its name.
    expect(mentionsIn('ali@example.com, @Alina, @ Ali, Ali', members)).toEqual([]);

    const order = await f.order(f.a, [kurta]);
    const agentId = newId();
    const comment = unwrap(
      await f.comments.create(staff('confirmation_agent', agentId), order.id, '@Ali call her'),
    );
    const factsOf = (commentId: string | null) =>
      f.db.tenant(f.a.shopId, (tx) => staffAlertFactsIn(tx, f.a.shopId, order.id, commentId));
    expect(await factsOf(comment.id)).toEqual({
      number: order.number,
      assigneeId: null,
      comment: { message: '@Ali call her', authorId: agentId },
    });
    unwrap(
      await f.orders.assign(
        f.a,
        order.id,
        { staffMemberId: agentId, name: 'Sana' },
        { fromOthers: true },
      ),
    );
    // An app's comment has no author among the staff; a comment gone, or not asked for, none.
    const apps = unwrap(await f.comments.create(f.a, order.id, '@Ali'));
    expect((await factsOf(apps.id))!.comment).toEqual({ message: '@Ali', authorId: null });
    unwrap(await f.comments.delete(f.a, apps.id, { anyones: false }));
    expect(await factsOf(apps.id)).toEqual({
      number: order.number,
      assigneeId: agentId,
      comment: null,
    });
    expect((await factsOf(null))!.comment).toBeNull();
    // Another shop's order, nothing.
    expect(
      await f.db.tenant(f.b.shopId, (tx) => staffAlertFactsIn(tx, f.b.shopId, order.id, null)),
    ).toBeNull();
  });
});
