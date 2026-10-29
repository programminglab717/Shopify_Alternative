import 'reflect-metadata';
import { AiGateway } from '@hatti/ai';
import { AiCredits, type AiCreditBalance, type AiCreditUse } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ReceiptReadingService,
  accountCheck,
  amountCheck,
  referenceKey,
} from './receipt-readings.js';
import { errorsOf, ordersFixture, unwrap, type OrdersFixture } from './test-support.js';

const server = testDatabaseServer();

const ACCOUNT = {
  title: 'Zari Textiles',
  bankName: 'Standard Chartered',
  iban: 'PK36SCBL0000001123456702',
};

/** A white picture, two pixels a side, as a PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4DwYMEAoAU7oL' +
    '9W/sIDEAAAAASUVORK5CYII=',
  'base64',
);
const PDF = Buffer.from('%PDF-1.7\n%receipt\n');

/** A plan's AI credits, each spend kept. */
class Credits extends AiCredits {
  left = 10;
  readonly spent: AiCreditUse[] = [];
  balanceOf(): Promise<AiCreditBalance> {
    return Promise.resolve({
      perMonth: 10,
      used: 10 - this.left,
      bought: 0,
      left: this.left,
      plan: 'Free',
      renewsAt: new Date('2026-11-01T00:00:00+05:00'),
    });
  }
  spend(_shopId: string, use: AiCreditUse) {
    this.spent.push(use);
    this.left -= 1;
    return Promise.resolve();
  }
}

/** A provider answering each receipt through the receipt tool from `answers`, in turn. */
function gatewayAnswering(answers: unknown[]) {
  const sent: { type: string; source?: { media_type: string } }[][] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      messages: { content: { type: string; source?: { media_type: string } }[] }[];
    };
    sent.push(body.messages[0]!.content);
    const answer = answers.shift();
    if (answer === 'down') return new Response('{}', { status: 400 });
    return new Response(
      JSON.stringify({
        content: [{ type: 'tool_use', name: 'give_receipt', input: answer }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1500, output_tokens: 90 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { gateway: new AiGateway({ apiKey: 'sk-test', model: 'model', fetch }), sent };
}

/** Today in Pakistan, as YYYY-MM-DD. */
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

describe('What Hatti makes of a reading (PAY-08, ADR-845)', () => {
  it('tells the account by its last digits, else by its title', () => {
    const told = { ...ACCOUNT, instructions: '', raastId: null };
    expect(accountCheck('PK36****6702', null, told)).toBe('matches');
    expect(accountCheck('A/C ****3456', null, told)).toBe('differs');
    expect(accountCheck('PK12MEZN****9911', 'Zari Textiles', told)).toBe('differs');
    const raast = { ...told, raastId: '+923001234567' };
    expect(accountCheck('0300 1234567', null, raast)).toBe('matches');
    expect(accountCheck('923001234567', null, raast)).toBe('matches');
    expect(accountCheck(null, 'ZARI TEXT', told)).toBe('matches');
    // A name alone never says it differs; no account told, nothing to tell.
    expect(accountCheck(null, 'Ali Traders', told)).toBe('unknown');
    expect(accountCheck('PK36****6702', null, null)).toBe('unknown');
  });

  it('compares amounts with what was owed, and references by their letters and digits', () => {
    expect(amountCheck(200_000n, 200_000n)).toBe('matches');
    expect(amountCheck(150_000n, 200_000n)).toBe('short');
    expect(amountCheck(250_000n, 200_000n)).toBe('over');
    expect(amountCheck(null, 200_000n)).toBe('unknown');
    expect(amountCheck(200_000n, 0n)).toBe('unknown');
    expect(referenceKey('tid: 0012-3456')).toBe('TID00123456');
    expect(referenceKey('12-34')).toBeNull();
  });
});

describe.skipIf(!server)('Receipts for transfers, read by the AI (PAY-08, ADR-845)', () => {
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
    [kurta] = (await f.variantsOf(f.a, 'Kurta', { price: '2,000' })) as [string];
    await f.stock(f.a, kurta, 5);
    unwrap(await f.bankTransfer.update(f.a, { enabled: true, account: ACCOUNT }));
  });

  /** A bank-transfer order with a receipt its customer sent, and the receipt's ID. */
  async function withReceipt(data: Buffer) {
    const order = await f.order(f.a, [kurta], { paymentMethod: 'bank_transfer' });
    const link = unwrap(await f.links.createLink(f.a, order.id));
    await f.links.sendReceipt(link.url.slice('https://hatti.test/o/'.length), { data });
    const [receipt] = (await f.receipts.receiptsOf(f.a, [order.id])).get(order.id)!;
    return { order, receiptId: receipt!.id };
  }

  it('reads a receipt once, checked against its order, and a reference sent twice', async () => {
    const first = await withReceipt(PIXEL);
    const second = await withReceipt(PIXEL);
    const rupees = (paisa: bigint) => `${paisa / 100n}.${String(paisa % 100n).padStart(2, '0')}`;
    const { gateway, sent } = gatewayAnswering([
      {
        receipt: true,
        amount: rupees(first.order.total),
        date: today(),
        reference: 'TID 0012 3456',
        sender_bank: 'Meezan Bank',
        recipient_name: 'ZARI TEXTILES',
        recipient_account: 'PK36****6702',
      },
      {
        receipt: true,
        amount: '1500',
        date: '2020-01-05',
        reference: 'tid-00123456',
        recipient_account: '****9911',
      },
    ]);
    const credits = new Credits();
    const readings = new ReceiptReadingService(f.db, f.storage, gateway, credits);
    expect(readings.available).toBe(true);
    expect((await readings.readingsOf(f.a, [first.receiptId])).get(first.receiptId)).toBeNull();

    const read = unwrap(await readings.read(f.a, first.receiptId));
    expect(read).toMatchObject({
      outcome: 'read',
      amount: first.order.total,
      paidOn: today(),
      reference: 'TID 0012 3456',
      senderBank: 'Meezan Bank',
      owed: first.order.total,
      amountCheck: 'matches',
      accountCheck: 'matches',
      sameReferenceOrders: [],
      beforeOrder: false,
    });
    // The picture alone, made a JPEG for the model.
    expect(sent[0]!.map((part) => [part.type, part.source?.media_type])).toEqual([
      ['image', 'image/jpeg'],
      ['text', undefined],
    ]);
    expect(credits.spent).toEqual(['transfer_receipt']);
    // Read once: asked again, the reading it has, for nothing.
    expect(unwrap(await readings.read(f.a, first.receiptId))).toEqual(read);
    expect([sent.length, credits.spent.length]).toEqual([1, 1]);

    expect(unwrap(await readings.read(f.a, second.receiptId))).toMatchObject({
      amount: 150_000n,
      amountCheck: 'short',
      accountCheck: 'differs',
      sameReferenceOrders: [first.order.number],
      beforeOrder: true,
    });
    // The first now says its reference was sent for the second too.
    expect((await readings.readingsOf(f.a, [first.receiptId])).get(first.receiptId)).toMatchObject({
      sameReferenceOrders: [second.order.number],
    });
    const [row] = (
      await f.admin.query<{ read_input_tokens: number; read_reference_key: string }>(
        'SELECT read_input_tokens, read_reference_key FROM orders.transfer_receipts WHERE id = $1',
        [second.receiptId],
      )
    ).rows;
    expect(row).toEqual({ read_input_tokens: 1500, read_reference_key: 'TID00123456' });
  });

  it("says what isn't a receipt, gives a PDF as a document, and reads a failed one again", async () => {
    const photo = await withReceipt(PIXEL);
    const bank = await withReceipt(PDF);
    const { gateway, sent } = gatewayAnswering([
      { receipt: false },
      'down',
      { receipt: true, amount: '100' },
    ]);
    const credits = new Credits();
    const readings = new ReceiptReadingService(f.db, f.storage, gateway, credits);
    expect(unwrap(await readings.read(f.a, photo.receiptId))).toMatchObject({
      outcome: 'not_a_receipt',
    });
    expect(errorsOf(await readings.read(f.a, bank.receiptId))).toEqual([['base', 'UNAVAILABLE']]);
    expect(credits.spent).toEqual(['transfer_receipt']);
    expect((await readings.readingsOf(f.a, [bank.receiptId])).get(bank.receiptId)).toMatchObject({
      outcome: 'failed',
    });
    expect(sent[1]![0]).toMatchObject({
      type: 'document',
      source: { media_type: 'application/pdf' },
    });
    expect(unwrap(await readings.read(f.a, bank.receiptId))).toMatchObject({
      outcome: 'read',
      amount: 10_000n,
      amountCheck: 'short',
      accountCheck: 'unknown',
    });
    expect(credits.spent).toEqual(['transfer_receipt', 'transfer_receipt']);
  });

  it('reads nothing without the AI, without credits, or of another shop', async () => {
    const { receiptId } = await withReceipt(PIXEL);
    const { gateway, sent } = gatewayAnswering([]);
    expect(errorsOf(await new ReceiptReadingService(f.db, f.storage).read(f.a, receiptId))).toEqual(
      [['base', 'UNAVAILABLE']],
    );
    const credits = new Credits();
    credits.left = 0;
    const readings = new ReceiptReadingService(f.db, f.storage, gateway, credits);
    expect(errorsOf(await readings.read(f.a, receiptId))).toEqual([['base', 'TOO_MANY']]);
    credits.left = 10;
    expect(errorsOf(await readings.read(f.b, receiptId))).toEqual([['id', 'NOT_FOUND']]);
    expect(sent).toEqual([]);
  });

  it('gives the receipts to read as they arrive, where the shop has them read so (ADR-915)', async () => {
    const { order, receiptId } = await withReceipt(PIXEL);
    const { gateway } = gatewayAnswering([{ receipt: false }]);
    const readings = new ReceiptReadingService(f.db, f.storage, gateway, new Credits());
    // Off until the shop turns it on; and never without the AI.
    expect(await readings.arrivedUnread(f.a.shopId, order.id)).toEqual([]);
    const settings = unwrap(await f.bankTransfer.update(f.a, { readReceipts: true }));
    expect(settings).toMatchObject({ enabled: true, readReceipts: true });
    expect(await readings.arrivedUnread(f.a.shopId, order.id)).toEqual([receiptId]);
    expect(
      await new ReceiptReadingService(f.db, f.storage).arrivedUnread(f.a.shopId, order.id),
    ).toEqual([]);
    expect(await readings.arrivedUnread(f.b.shopId, order.id)).toEqual([]);
    // Read once, it is not given again.
    unwrap(await readings.read(f.a, receiptId));
    expect(await readings.arrivedUnread(f.a.shopId, order.id)).toEqual([]);
    // The switch is audited with the shop's other transfer settings.
    const { rows } = await f.admin.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM platform.audit_log
        WHERE shop_id = $1 AND action = 'bank_transfer_settings.updated'
        ORDER BY occurred_at DESC LIMIT 1`,
      [f.a.shopId],
    );
    expect(rows[0]!.details).toMatchObject({
      readReceipts: true,
      before: { readReceipts: false },
    });
  });
});
