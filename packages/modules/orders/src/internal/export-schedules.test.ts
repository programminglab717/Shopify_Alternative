import 'reflect-metadata';
import type { StaffRole, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { xlsxRows } from '@hatti/xlsx/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ScheduledExportSender,
  exportPeriod,
  periodFilename,
  scheduledExportEmail,
  type ScheduledExportEmail,
} from './export-schedule-email.js';
import { EXPORT_SCHEDULE_LIMITS, ExportScheduleService } from './export-schedule.service.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

/** Keeps each email it is given, answering as told. */
class KeptEmails extends ScheduledExportSender {
  readonly sent: ScheduledExportEmail[] = [];
  answer: 'sent' | 'retry' | 'failed' = 'sent';

  async send(email: ScheduledExportEmail): Promise<'sent' | 'retry' | 'failed'> {
    this.sent.push(email);
    return this.answer;
  }
}

const FILE = { filename: 'x', contentType: 'text/csv', content: Buffer.from('') };

describe("Scheduled exports' periods and words", () => {
  it('names each period by its days, and its file for them', () => {
    expect(exportPeriod('daily', '2026-10-05')).toEqual({
      firstDay: '2026-10-04',
      lastDay: '2026-10-04',
      endDay: '2026-10-05',
    });
    expect(exportPeriod('weekly', '2026-10-05')).toMatchObject({
      firstDay: '2026-09-28',
      lastDay: '2026-10-04',
    });
    expect(exportPeriod('monthly', '2026-03-01')).toMatchObject({
      firstDay: '2026-02-01',
      lastDay: '2026-02-28',
    });
    expect(periodFilename('daily', 'orders', exportPeriod('daily', '2026-10-05'), 'xlsx')).toBe(
      'orders-2026-10-04.xlsx',
    );
    expect(
      periodFilename('weekly', 'line_items', exportPeriod('weekly', '2026-10-05'), 'csv'),
    ).toBe('order-items-2026-09-28-to-2026-10-04.csv');
    expect(periodFilename('monthly', 'orders', exportPeriod('monthly', '2026-10-01'), 'xlsx')).toBe(
      'orders-2026-09.xlsx',
    );
  });

  it('says whose orders, which period and how many, and why it came', () => {
    const daily = scheduledExportEmail({
      to: 'sana@example.pk',
      name: 'Sana',
      shop: 'Zari <Fashions>',
      frequency: 'daily',
      layout: 'orders',
      period: exportPeriod('daily', '2026-10-05'),
      rows: 23,
      file: { ...FILE, filename: 'orders-2026-10-04.xlsx' },
    });
    expect(daily.subject).toBe('Orders from Zari <Fashions>: 4 Oct 2026');
    expect(daily.text).toBe(
      'Assalam o alaikum Sana,\n\n' +
        "Zari <Fashions>'s orders placed on 4 Oct 2026: 23 orders, in the attached " +
        'orders-2026-10-04.xlsx.\n\n' +
        "You get this every day because you scheduled it in Hatti. To stop it, delete the schedule in Hatti's admin.",
    );
    expect(daily.html).toContain('<p>Zari &lt;Fashions&gt;&#39;s orders placed on 4 Oct 2026');
    expect(daily.attachment.filename).toBe('orders-2026-10-04.xlsx');
    const weekly = scheduledExportEmail({
      to: 'sana@example.pk',
      name: 'Sana',
      shop: 'Zari',
      frequency: 'weekly',
      layout: 'line_items',
      period: exportPeriod('weekly', '2026-01-05'),
      rows: 1,
      file: FILE,
    });
    expect(weekly.subject).toBe('Orders from Zari: 29 Dec 2025 to 4 Jan 2026');
    expect(weekly.text).toContain('placed from 29 Dec 2025 to 4 Jan 2026: 1 line item, in');
    expect(weekly.text).toContain('every week');
    const monthly = scheduledExportEmail({
      to: 'sana@example.pk',
      name: 'Sana',
      shop: 'Zari',
      frequency: 'monthly',
      layout: 'orders',
      period: exportPeriod('monthly', '2026-10-01'),
      rows: 0,
      file: FILE,
    });
    expect(monthly.subject).toBe('Orders from Zari: September 2026');
    expect(monthly.text).toContain('placed in September 2026: no orders, in');
  });
});

describe.skipIf(!server)('Scheduled exports (ADR-183)', () => {
  let f: OrdersFixture;
  /** With the system role too, which finds what is due across shops. */
  let db: Database;
  let schedules: ExportScheduleService;
  let kurta: string;
  let owner: string;

  /** 06:00 on Monday 5 October in Karachi. */
  const MONDAY = new Date('2026-10-05T01:00:00Z');

  /** A member of staff of shop A, by their account, with an email proved unless said. */
  const member = async (role: StaffRole, options: { proved?: boolean } = {}) => {
    const id = newId();
    await f.admin.query(
      `INSERT INTO identity.users (id, email, email_verified_at, name)
       VALUES ($1, $2, $3, $4)`,
      [
        id,
        `${role}-${id.slice(-6)}@example.pk`,
        options.proved === false ? null : new Date(),
        role,
      ],
    );
    await f.admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [id, f.a.shopId, role],
    );
    return id;
  };

  const as = (userId: string, role: StaffRole): TenantContext => ({
    ...f.a,
    actor: { kind: 'staff', userId, sessionId: newId(), authenticatedAt: new Date(), role },
  });

  const schedule = async (userId: string, role: StaffRole, at: Date = MONDAY) =>
    unwrap(
      await schedules.create(
        as(userId, role),
        { frequency: 'daily', layout: 'orders', format: 'xlsx' },
        at,
      ),
    );

  /** Places an order for a kurta at `at`. */
  const placed = async (at: string) => {
    const order = await f.order(f.a, [kurta]);
    await f.admin.query('UPDATE orders.orders SET created_at = $2 WHERE id = $1', [order.id, at]);
    return order;
  };

  beforeAll(async () => {
    f = await ordersFixture(server!);
    db = new Database({
      appUrl: f.testDb.appUrl,
      systemUrl: f.testDb.systemUrl,
      applicationName: 'export-schedules-test',
    });
    schedules = new ExportScheduleService(db, f.exports);
  });

  afterAll(async () => {
    await db?.close();
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    await f.admin.query(
      'DELETE FROM orders.export_schedules; DELETE FROM identity.memberships; ' +
        'DELETE FROM identity.users; DELETE FROM platform.audit_log',
    );
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 20);
    owner = await member('owner');
  });

  it("schedules a member's export, its first period the one whose hour is still to come", async () => {
    const make = (frequency: 'daily' | 'weekly' | 'monthly', hour?: number) =>
      schedules.create(
        as(owner, 'owner'),
        { frequency, hour, layout: 'orders', format: 'csv' },
        MONDAY,
      );
    // At 06:00: the day and the week just ended go at 08:00 today; the month ended days ago.
    expect(unwrap(await make('daily'))).toMatchObject({
      userId: owner,
      frequency: 'daily',
      hour: 8,
      query: '',
      nextRunAt: new Date('2026-10-05T03:00:00Z'),
      nextPeriod: { firstDay: '2026-10-04', lastDay: '2026-10-04' },
      lastSentAt: null,
      lastError: null,
    });
    expect(unwrap(await make('weekly'))).toMatchObject({
      nextRunAt: new Date('2026-10-05T03:00:00Z'),
      nextPeriod: { firstDay: '2026-09-28', lastDay: '2026-10-04' },
    });
    expect(unwrap(await make('monthly'))).toMatchObject({
      nextRunAt: new Date('2026-11-01T03:00:00Z'),
      nextPeriod: { firstDay: '2026-10-01', lastDay: '2026-10-31' },
    });
    // 05:00 has passed today: today goes at 05:00 tomorrow.
    expect(unwrap(await make('daily', 5))).toMatchObject({
      nextRunAt: new Date('2026-10-06T00:00:00Z'),
      nextPeriod: { firstDay: '2026-10-05', lastDay: '2026-10-05' },
    });
    const audit = await f.db.tenant(f.a.shopId, (tx) =>
      listAudit(tx, f.a.shopId, { first: 1, action: 'orders.export_scheduled' }),
    );
    expect(audit.items.map((item) => [item.actorId, item.actorRole, item.details])).toEqual([
      [
        owner,
        'owner',
        { frequency: 'DAILY', hour: 5, layout: 'ORDERS', format: 'CSV', query: null },
      ],
    ]);
  });

  it("refuses apps, roles that don't export, a bad hour or search, an unproved email, and too many", async () => {
    const input = { frequency: 'daily', layout: 'orders', format: 'xlsx' } as const;
    expect(errorsOf(await schedules.create(f.a, input))).toEqual([['input', 'INVALID']]);
    const packer = await member('packer');
    expect(errorsOf(await schedules.create(as(packer, 'packer'), input))).toEqual([
      ['input', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await schedules.create(as(owner, 'owner'), { ...input, hour: 24, query: 'stage:nope' }),
      ),
    ).toEqual([
      ['input.hour', 'INVALID'],
      ['input.query', 'INVALID'],
    ]);
    const unproved = await member('accountant', { proved: false });
    const refused = await schedules.create(as(unproved, 'accountant'), input);
    expect(refused).toMatchObject({
      ok: false,
      errors: [
        { message: "Prove your account's email first: scheduled exports are emailed to it" },
      ],
    });
    for (let index = 0; index < EXPORT_SCHEDULE_LIMITS.perShop; index++)
      await schedule(owner, 'owner');
    expect(errorsOf(await schedules.create(as(owner, 'owner'), input))).toEqual([
      ['input', 'TOO_MANY'],
    ]);
  });

  it("sends each period's orders once it ends, as its member sees them, then the next", async () => {
    const yesterday = await placed('2026-10-04T05:00:00Z');
    await placed('2026-10-03T12:00:00Z');
    // 00:30 on the 5th in Karachi: today's.
    await placed('2026-10-04T19:30:00Z');
    const accountant = await member('accountant');
    const theirs = await schedule(accountant, 'accountant');
    const emails = new KeptEmails();

    expect(await schedules.due(new Date('2026-10-05T02:59:00Z'))).toEqual([]);
    const at = new Date('2026-10-05T03:00:00Z');
    expect(await schedules.due(at)).toEqual([{ shopId: f.a.shopId, id: theirs.id }]);
    // Two workers at once: one sends it.
    expect(
      (
        await Promise.all([
          schedules.run(f.a.shopId, theirs.id, at, emails),
          schedules.run(f.a.shopId, theirs.id, at, emails),
        ])
      ).sort(),
    ).toEqual(['none', 'sent']);
    expect(emails.sent).toHaveLength(1);
    const [email] = emails.sent;
    expect(email).toMatchObject({
      to: expect.stringMatching(/^accountant-\w+@example\.pk$/),
      subject: 'Orders from A: 4 Oct 2026',
      attachment: {
        filename: 'orders-2026-10-04.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
    expect(email!.text).toContain("A's orders placed on 4 Oct 2026: 1 order, in the attached");
    const [header, row, ...more] = xlsxRows(email!.attachment.content);
    expect(more).toEqual([]);
    expect(row![header!.indexOf('Order')]).toBe(`#${yesterday.number}`);
    // An accountant sees numbers masked, in the file as anywhere.
    expect(row![header!.indexOf('Phone')]).toBe('0300 ••••567');

    // On to the next day, due at 08:00 tomorrow.
    const [after] = await schedules.list(f.a);
    expect(after).toMatchObject({
      nextRunAt: new Date('2026-10-06T03:00:00Z'),
      nextPeriod: { firstDay: '2026-10-05' },
      lastSentAt: at,
      lastError: null,
    });
    expect(await schedules.run(f.a.shopId, theirs.id, at, emails)).toBe('none');
    // Recorded as the member's export, for the schedule.
    const audit = await f.db.tenant(f.a.shopId, (tx) =>
      listAudit(tx, f.a.shopId, { first: 1, action: 'orders.exported' }),
    );
    expect(audit.items.map((item) => [item.actorId, item.actorRole, item.details])).toEqual([
      [
        accountant,
        'accountant',
        expect.objectContaining({
          rows: 1,
          format: 'XLSX',
          schedule: toPublicId('exportSchedule', theirs.id),
          placedFrom: '2026-10-03T19:00:00.000Z',
          placedBefore: '2026-10-04T19:00:00.000Z',
        }),
      ],
    ]);
  });

  it("tries again what the email service can't take yet, for a day, and gives up what no one may get", async () => {
    const mine = await schedule(owner, 'owner');
    const emails = new KeptEmails();
    emails.answer = 'retry';
    const at = new Date('2026-10-05T03:00:00Z');
    expect(await schedules.run(f.a.shopId, mine.id, at, emails)).toBe('retry');
    expect((await schedules.list(f.a))[0]).toMatchObject({
      nextRunAt: new Date('2026-10-05T03:01:00Z'),
      nextPeriod: { firstDay: '2026-10-04' },
      lastError: 'The email could not be sent yet: trying again',
    });
    expect(await schedules.run(f.a.shopId, mine.id, new Date('2026-10-05T03:01:00Z'), emails)).toBe(
      'retry',
    );
    expect((await schedules.list(f.a))[0]!.nextRunAt).toEqual(new Date('2026-10-05T03:03:00Z'));
    // A day late: given up, on to the next.
    const late = new Date('2026-10-06T03:30:00Z');
    expect(await schedules.run(f.a.shopId, mine.id, late, emails)).toBe('skipped');
    expect((await schedules.list(f.a))[0]).toMatchObject({
      nextPeriod: { firstDay: '2026-10-05' },
      lastError: 'Not sent: the email could not be sent within a day',
    });

    // Refused outright: on to the next.
    emails.answer = 'failed';
    expect(await schedules.run(f.a.shopId, mine.id, late, emails)).toBe('skipped');
    expect((await schedules.list(f.a))[0]).toMatchObject({
      nextPeriod: { firstDay: '2026-10-06' },
      lastError: 'Not sent: the email service refused it',
    });

    // A member who left, or whose role exports no more, gets nothing.
    emails.sent.length = 0;
    await f.admin.query("UPDATE identity.memberships SET role = 'packer' WHERE user_id = $1", [
      owner,
    ]);
    const later = new Date('2026-10-08T03:00:00Z');
    expect(await schedules.run(f.a.shopId, mine.id, later, emails)).toBe('skipped');
    expect((await schedules.list(f.a))[0]!.lastError).toBe(
      "Not sent: its member of staff's role no longer exports orders",
    );
    await f.admin.query('DELETE FROM identity.memberships WHERE user_id = $1', [owner]);
    expect(await schedules.run(f.a.shopId, mine.id, later, emails)).toBe('skipped');
    expect((await schedules.list(f.a))[0]).toMatchObject({
      nextPeriod: { firstDay: '2026-10-08' },
      lastError:
        'Not sent: its member of staff no longer works in the shop, or has no proved email',
    });
    expect(emails.sent).toEqual([]);
  });

  it("lists the shop's schedules, and deletes a member's own, or any for owners and apps", async () => {
    const accountant = await member('accountant');
    const ownerMade = await schedule(owner, 'owner');
    const theirs = await schedule(accountant, 'accountant');
    expect((await schedules.list(f.a)).map((item) => item.id)).toEqual([theirs.id, ownerMade.id]);
    expect(await schedules.list(f.b)).toEqual([]);

    expect(errorsOf(await schedules.delete(as(accountant, 'accountant'), ownerMade.id))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await schedules.delete(f.b, ownerMade.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(await schedules.delete(as(accountant, 'accountant'), theirs.id)).toEqual({
      ok: true,
      value: theirs.id,
    });
    expect(await schedules.delete(f.a, ownerMade.id)).toEqual({ ok: true, value: ownerMade.id });
    expect(await schedules.list(f.a)).toEqual([]);
    const audit = await f.db.tenant(f.a.shopId, (tx) =>
      listAudit(tx, f.a.shopId, { first: 2, action: 'orders.export_unscheduled' }),
    );
    expect(audit.items.map((item) => [item.subjectId, item.details])).toEqual([
      [ownerMade.id, { staffMember: toPublicId('user', owner) }],
      [theirs.id, { staffMember: toPublicId('user', accountant) }],
    ]);
  });
});
