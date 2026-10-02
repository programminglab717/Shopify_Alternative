import 'reflect-metadata';
import type { TenantContext } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("Couriers' labels and load sheets", () => {
  let f: LogisticsFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await logisticsFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
    unwrap(
      await f.accounts.connect(f.a, {
        courier: 'test',
        name: 'Test Lahore',
        credentials: [{ key: 'key', value: 'anything-1234' }],
        pickupCode: 'LHR-0042',
      }),
    );
    await f.admin.query(
      `UPDATE inventory.locations
          SET address1 = 'Plot 7, Sundar Industrial Estate', city = 'Lahore',
              phone = '+923211234567'
        WHERE shop_id = $1`,
      [f.a.shopId],
    );
  });

  const staff = (role: 'packer' | 'owner'): TenantContext => ({
    ...f.a,
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role,
    },
  });

  const english = { paper: 'thermal_4x6' as const, language: 'english' as const };

  it('prints a label a parcel: its courier, barcode, customer, cash and contents', async () => {
    const parcel = await f.booked(f.a, kurta, { quantity: 2 });
    const printed = unwrap(await f.documents.labels(f.a, [parcel.bookingId], english));
    expect(printed).toMatchObject({
      title: `Label #${parcel.number}`,
      fileName: `label-${parcel.number}.html`,
    });
    expect(printed.bookings.map((booking) => booking.id)).toEqual([parcel.bookingId]);
    const { html } = printed;
    expect(html).toContain('size: 4in 6in');
    expect(html).toContain('Test courier');
    expect(html).toContain(`<svg class="barcode"`);
    expect(html).toContain(`aria-label="${parcel.trackingNumber}"`);
    expect(html).toContain(`#${parcel.number}`);
    for (const line of [
      'Ayesha Khan',
      'House 12, Street 4',
      'Gulberg III',
      'near Liberty Market',
      'Lahore',
      // An app sees numbers whole.
      '0300 1234567',
      'Cash to collect',
      'Rs 4,000',
      'Pieces',
      'Kurta x 2',
      'Plot 7, Sundar Industrial Estate',
      '0321 1234567',
    ]) {
      expect(html).toContain(line);
    }
    // Packers see the customer's number masked, as on packing slips.
    const packer = unwrap(await f.documents.labels(staff('packer'), [parcel.bookingId], english));
    expect(packer.html).toContain('0300 ••••567');
    expect(packer.html).not.toContain('0300 1234567');
    // In Urdu too.
    const urdu = unwrap(
      await f.documents.labels(f.a, [parcel.bookingId], { ...english, language: 'urdu' }),
    );
    expect(urdu.html).toContain('dir="rtl"');
    expect(urdu.html).toContain('وصول کی جانے والی رقم');
  });

  it('prints four to a sheet of A4, leaving out bookings not booked', async () => {
    const parcels = [];
    for (let i = 0; i < 5; i++) parcels.push(await f.booked(f.a, kurta));
    const waiting = await f.confirmed(f.a, kurta);
    const [pending] = unwrap(
      await f.bookings.request(f.a, { orderIds: [waiting.orderId] }),
    ).bookings;
    const ids = [pending!.id, ...parcels.map((parcel) => parcel.bookingId).reverse()];
    const sheets = unwrap(
      await f.documents.labels(f.a, [...ids, ids[1]!], { paper: 'a4', language: 'bilingual' }),
    );
    expect(sheets.bookings.map((booking) => booking.id)).toEqual(ids.slice(1));
    expect(sheets.title).toBe('Labels: 5 parcels');
    const numbers = parcels.map((parcel) => parcel.number);
    expect(sheets.fileName).toBe(`labels-${Math.min(...numbers)}-${Math.max(...numbers)}.html`);
    expect(sheets.html.match(/<article class="page">/g)).toHaveLength(2);
    expect(sheets.html.match(/<div class="labels">/g)).toHaveLength(2);
    expect(sheets.html.match(/<div class="shipping-label">/g)).toHaveLength(5);
    expect(sheets.html).toContain('size: A4');

    // Nothing booked, the paper of receipts, or too many: refused.
    expect(errorsOf(await f.documents.labels(f.a, [pending!.id], english))).toEqual([
      ['ids', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await f.documents.labels(f.a, [parcels[0]!.bookingId], {
          paper: 'thermal_80mm',
          language: 'english',
        }),
      ),
    ).toEqual([['paper', 'INVALID']]);
    expect(errorsOf(await f.documents.labels(f.a, [], english))).toEqual([['ids', 'BLANK']]);
    expect(
      errorsOf(
        await f.documents.labels(
          f.a,
          Array.from({ length: 251 }, () => newId()),
          english,
        ),
      ),
    ).toEqual([['ids', 'TOO_MANY']]);
    // Another shop's bookings are not there.
    expect(errorsOf(await f.documents.labels(f.b, [parcels[0]!.bookingId], english))).toEqual([
      ['ids', 'INVALID'],
    ]);
  });

  it('says a paid order collects nothing, and prints none for an erased customer', async () => {
    const paid = await f.confirmed(f.a, kurta);
    unwrap(await f.orders.recordPayment(f.a, paid.orderId));
    const [booking] = unwrap(await f.bookings.request(f.a, { orderIds: [paid.orderId] })).bookings;
    await f.bookings.recordTrackingNumber(f.a.shopId, booking!.id, 'HT9000000001', 0n);
    const { fulfillmentId } = unwrap(
      await f.fulfillments.fulfill({ shopId: f.a.shopId, actor: 'system' }, paid.orderId, {
        tracking: { company: 'Test courier', number: 'HT9000000001' },
      }),
    );
    await f.bookings.markBooked(f.a.shopId, booking!.id, { fulfillmentId, at: new Date() });
    const label = unwrap(await f.documents.labels(f.a, [booking!.id], english));
    expect(label.html).toContain('Paid: nothing to collect');
    expect(label.html).not.toContain('Cash to collect');

    const erased = await f.booked(f.a, kurta);
    // As an erasure leaves it: no number, and when it was erased.
    await f.admin.query(
      `UPDATE orders.orders SET customer_erased_at = now(), phone = NULL WHERE id = $1`,
      [erased.orderId],
    );
    expect(errorsOf(await f.documents.labels(f.a, [erased.bookingId], english))).toEqual([
      ['ids', 'INVALID'],
    ]);
  });

  it("lists an account's parcels waiting for pickup on its load sheet, with their cash", async () => {
    expect(errorsOf(await f.documents.loadSheet(f.b, { language: 'english' }))).toEqual([
      ['accountId', 'BLANK'],
    ]);
    expect(errorsOf(await f.documents.loadSheet(f.a, { language: 'english' }))).toEqual([
      ['accountId', 'INVALID'],
    ]);
    const first = await f.booked(f.a, kurta, { city: 'Karachi' });
    const second = await f.booked(f.a, kurta, { quantity: 3 });
    const picked = await f.booked(f.a, kurta);
    await f.admin.query(
      `UPDATE logistics.bookings SET parcel_status = 'in_transit' WHERE id = $1`,
      [picked.bookingId],
    );
    const at = new Date('2026-10-02T09:30:00Z');
    const sheet = unwrap(await f.documents.loadSheet(f.a, { language: 'english', at }));
    expect(sheet).toMatchObject({
      title: 'Load sheet: Test Lahore',
      fileName: 'load-sheet-test-2026-10-02.html',
    });
    expect(sheet.bookings.map((booking) => booking.id)).toEqual([
      first.bookingId,
      second.bookingId,
    ]);
    const { html } = sheet;
    for (const text of [
      'Load sheet',
      'Test courier',
      'Test Lahore',
      'LHR-0042',
      '2 Oct 2026',
      first.trackingNumber,
      second.trackingNumber,
      'Karachi',
      'Ayesha Khan',
      'Rs 2,000',
      'Rs 6,000',
      // Two parcels, four pieces, Rs 8,000 to collect.
      'Rs 8,000',
      'Handed over by',
      'Received by the courier&#39;s rider',
      'Signature',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain(picked.trackingNumber);
    expect(html).toContain('size: A4');
    const unknown = newId();
    expect(
      errorsOf(await f.documents.loadSheet(f.a, { accountId: unknown, language: 'english' })),
    ).toEqual([['accountId', 'NOT_FOUND']]);
  });
});
