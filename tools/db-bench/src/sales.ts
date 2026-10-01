import { createHash } from 'node:crypto';
import { newId } from '@hatti/ids';
import { searchKey } from '@hatti/pk';
import type pg from 'pg';
import type { Random } from './random.js';

/**
 * What shops sell and to whom: a location with stock, customers, orders with their lines, parcels
 * and timelines, and shoppers' carts. Orders, customers and carts are what requests read most
 * after products, so the benchmark checks their statements' plans and times them too.
 */

/** A variant as orders and carts take it. */
export interface SoldVariant {
  id: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string;
  /** Minor units. */
  price: number;
}

/** Customer number k (1-based) of a shop: unique in the shop, and a valid Pakistani mobile. */
export function customerPhone(k: number): string {
  return `+923${String(k).padStart(9, '0')}`;
}

/**
 * The secret of cart number k (1-based) of a shop, as shoppers' cookies hold them: 22 characters
 * of base64url. Only its SHA-256 is kept, so the benchmark rebuilds it to read the cart.
 */
export function cartToken(shopNumber: number, k: number): string {
  return `b${shopNumber}c${String(k).padStart(14, '0')}`;
}

const FIRST_NAMES = [
  'Ayesha',
  'Fatima',
  'Zainab',
  'Maryam',
  'Sana',
  'Hina',
  'Amna',
  'Sadia',
  'Rabia',
  'Nida',
  'Ali',
  'Ahmed',
  'Bilal',
  'Hamza',
  'Usman',
  'Imran',
  'Faisal',
  'Kamran',
  'Saad',
  'Zeeshan',
];
const LAST_NAMES = [
  'Khan',
  'Ahmed',
  'Malik',
  'Butt',
  'Sheikh',
  'Qureshi',
  'Siddiqui',
  'Chaudhry',
  'Raza',
  'Hussain',
  'Iqbal',
  'Javed',
  'Mirza',
  'Abbasi',
  'Baloch',
  'Memon',
];
const CITIES: readonly (readonly [[city: string, province: string], number])[] = [
  [['Karachi', 'SD'], 20],
  [['Lahore', 'PB'], 18],
  [['Islamabad', 'IS'], 8],
  [['Rawalpindi', 'PB'], 7],
  [['Faisalabad', 'PB'], 6],
  [['Multan', 'PB'], 5],
  [['Peshawar', 'KP'], 5],
  [['Hyderabad', 'SD'], 4],
  [['Quetta', 'BA'], 3],
  [['Gujranwala', 'PB'], 3],
  [['Sialkot', 'PB'], 3],
  [['Bahawalpur', 'PB'], 2],
  [['Sukkur', 'SD'], 2],
  [['Abbottabad', 'KP'], 2],
];
const AREAS = ['Gulshan-e-Iqbal', 'DHA Phase 5', 'Model Town', 'Satellite Town', 'Saddar', null];
const COURIERS = ['TCS', 'Leopards', 'PostEx', 'M&P', 'Trax'];
const SOURCES: readonly (readonly [string, number])[] = [
  ['online_store', 50],
  ['whatsapp', 25],
  ['instagram', 10],
  ['facebook', 10],
  ['manual', 5],
];

type Stage =
  | 'needs_confirmation'
  | 'needs_review'
  | 'awaiting_payment'
  | 'to_pack'
  | 'to_book'
  | 'in_transit'
  | 'returning'
  | 'delivered'
  | 'completed'
  | 'returned'
  | 'lost'
  | 'cancelled';

/** Most orders of a shop that has sold for a while are done with; a few wait for staff. */
const STAGES: readonly (readonly [Stage, number])[] = [
  ['delivered', 30],
  ['completed', 25],
  ['cancelled', 10],
  ['returned', 8],
  ['in_transit', 8],
  ['needs_confirmation', 6],
  ['to_pack', 4],
  ['to_book', 3],
  ['returning', 2],
  ['needs_review', 2],
  ['awaiting_payment', 1],
  ['lost', 1],
];

/** The parcel's status at each stage that has one. */
const PARCELS: Partial<Record<Stage, string>> = {
  in_transit: 'in_transit',
  returning: 'returning',
  delivered: 'delivered',
  completed: 'delivered',
  returned: 'returned',
  lost: 'lost',
};

interface SalesRows {
  locations: { shopId: string[]; id: string[] };
  items: { shopId: string[]; variantId: string[]; productId: string[]; locationId: string[] };
  levels: { onHand: number[] };
  customers: {
    shopId: string[];
    id: string[];
    phone: string[];
    name: string[];
    email: (string | null)[];
    searchText: string[];
    createdAt: string[];
  };
  orders: {
    shopId: string[];
    id: string[];
    number: number[];
    source: string[];
    status: string[];
    confirmationStatus: string[];
    financialStatus: string[];
    fulfillmentStatus: string[];
    stage: string[];
    paymentMethod: string[];
    subtotal: number[];
    shipping: number[];
    total: number[];
    amountPaid: number[];
    codAmount: number[];
    customerId: string[];
    phone: string[];
    email: (string | null)[];
    address: string[];
    locationId: string[];
    searchText: string[];
    cancelReason: (string | null)[];
    riskScore: (number | null)[];
    riskLevel: (string | null)[];
    confirmedAt: (string | null)[];
    packedAt: (string | null)[];
    cancelledAt: (string | null)[];
    paidAt: (string | null)[];
    closedAt: (string | null)[];
    createdAt: string[];
  };
  lines: {
    shopId: string[];
    id: string[];
    orderId: string[];
    position: number[];
    variantId: string[];
    productId: string[];
    title: string[];
    variantTitle: string[];
    sku: string[];
    quantity: number[];
    unitPrice: number[];
    fulfilled: number[];
  };
  parcels: {
    shopId: string[];
    id: string[];
    orderId: string[];
    locationId: string[];
    status: string[];
    company: string[];
    trackingNumber: string[];
    shippedAt: string[];
    deliveredAt: (string | null)[];
    returningAt: (string | null)[];
    returnedAt: (string | null)[];
    lostAt: (string | null)[];
  };
  parcelLines: { shopId: string[]; parcelId: string[]; lineId: string[]; quantity: number[] };
  events: {
    shopId: string[];
    id: string[];
    orderId: string[];
    kind: string[];
    message: string[];
    createdAt: string[];
  };
  /** Comments staff wrote on orders' timelines (ADR-128), each by the shop's one agent. */
  comments: {
    shopId: string[];
    id: string[];
    orderId: string[];
    message: string[];
    authorId: string[];
    createdAt: string[];
  };
  carts: { shopId: string[]; id: string[]; tokenHash: Buffer[]; lines: string[] };
}

export function emptySales(): SalesRows {
  return {
    locations: { shopId: [], id: [] },
    items: { shopId: [], variantId: [], productId: [], locationId: [] },
    levels: { onHand: [] },
    customers: {
      shopId: [],
      id: [],
      phone: [],
      name: [],
      email: [],
      searchText: [],
      createdAt: [],
    },
    orders: {
      shopId: [],
      id: [],
      number: [],
      source: [],
      status: [],
      confirmationStatus: [],
      financialStatus: [],
      fulfillmentStatus: [],
      stage: [],
      paymentMethod: [],
      subtotal: [],
      shipping: [],
      total: [],
      amountPaid: [],
      codAmount: [],
      customerId: [],
      phone: [],
      email: [],
      address: [],
      locationId: [],
      searchText: [],
      cancelReason: [],
      riskScore: [],
      riskLevel: [],
      confirmedAt: [],
      packedAt: [],
      cancelledAt: [],
      paidAt: [],
      closedAt: [],
      createdAt: [],
    },
    lines: {
      shopId: [],
      id: [],
      orderId: [],
      position: [],
      variantId: [],
      productId: [],
      title: [],
      variantTitle: [],
      sku: [],
      quantity: [],
      unitPrice: [],
      fulfilled: [],
    },
    parcels: {
      shopId: [],
      id: [],
      orderId: [],
      locationId: [],
      status: [],
      company: [],
      trackingNumber: [],
      shippedAt: [],
      deliveredAt: [],
      returningAt: [],
      returnedAt: [],
      lostAt: [],
    },
    parcelLines: { shopId: [], parcelId: [], lineId: [], quantity: [] },
    events: { shopId: [], id: [], orderId: [], kind: [], message: [], createdAt: [] },
    comments: { shopId: [], id: [], orderId: [], message: [], authorId: [], createdAt: [] },
    carts: { shopId: [], id: [], tokenHash: [], lines: [] },
  };
}

const HOUR = 3_600_000;

/**
 * Adds a shop's location, its stock of most variants, `orderCount` orders from about three
 * customers for every four orders, each with its timeline, and `cartCount` carts, to `rows`.
 * Orders are spread over the last year; ones still waiting for staff are recent.
 */
export function addSales(
  random: Random,
  rows: SalesRows,
  shop: { id: string; number: number },
  variants: readonly SoldVariant[],
  orderCount: number,
  cartCount: number,
): void {
  if (variants.length === 0) return;
  const shopId = shop.id;
  const locationId = newId();
  const agentId = newId();
  rows.locations.shopId.push(shopId);
  rows.locations.id.push(locationId);
  for (const variant of variants) {
    if (!random.chance(0.6)) continue;
    rows.items.shopId.push(shopId);
    rows.items.variantId.push(variant.id);
    rows.items.productId.push(variant.productId);
    rows.items.locationId.push(locationId);
    rows.levels.onHand.push(random.int(0, 40));
  }

  const now = Date.now();
  const customerCount = Math.max(1, Math.round(orderCount * 0.75));
  const customers: { id: string; phone: string; name: string; email: string | null }[] = [];
  for (let k = 1; k <= customerCount; k++) {
    const name = `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`;
    const email = random.chance(0.3)
      ? `${name.toLowerCase().replace(' ', '.')}${k}@example.com`
      : null;
    const customer = { id: newId(), phone: customerPhone(k), name, email };
    customers.push(customer);
    rows.customers.shopId.push(shopId);
    rows.customers.id.push(customer.id);
    rows.customers.phone.push(customer.phone);
    rows.customers.name.push(name);
    rows.customers.email.push(email);
    rows.customers.searchText.push(searchKey([name, email ?? ''].join(' ')));
    rows.customers.createdAt.push(new Date(now - random.int(0, 365 * 24) * HOUR).toISOString());
  }

  const { orders, lines, parcels, parcelLines } = rows;
  for (let k = 1; k <= orderCount; k++) {
    const stage = random.weighted(STAGES);
    const done = ['delivered', 'completed', 'returned', 'lost', 'cancelled'].includes(stage);
    const placed = now - (done ? random.int(72, 365 * 24) : random.int(1, 72)) * HOUR;
    const at = (hours: number) => new Date(placed + hours * HOUR).toISOString();
    const customer = random.pick(customers);
    const [city, province] = random.weighted(CITIES);
    const orderId = newId();

    let subtotal = 0;
    const lineCount = random.weighted([
      [1, 70],
      [2, 20],
      [3, 10],
    ]);
    const parcelId = newId();
    const parcelStatus = PARCELS[stage];
    for (let position = 1; position <= lineCount; position++) {
      const variant = random.pick(variants);
      const quantity = random.weighted([
        [1, 80],
        [2, 15],
        [3, 5],
      ]);
      const lineId = newId();
      subtotal += variant.price * quantity;
      lines.shopId.push(shopId);
      lines.id.push(lineId);
      lines.orderId.push(orderId);
      lines.position.push(position);
      lines.variantId.push(variant.id);
      lines.productId.push(variant.productId);
      lines.title.push(variant.title);
      lines.variantTitle.push(variant.variantTitle);
      lines.sku.push(variant.sku);
      lines.quantity.push(quantity);
      lines.unitPrice.push(variant.price);
      lines.fulfilled.push(parcelStatus ? quantity : 0);
      if (parcelStatus) {
        parcelLines.shopId.push(shopId);
        parcelLines.parcelId.push(parcelId);
        parcelLines.lineId.push(lineId);
        parcelLines.quantity.push(quantity);
      }
    }
    if (parcelStatus) {
      parcels.shopId.push(shopId);
      parcels.id.push(parcelId);
      parcels.orderId.push(orderId);
      parcels.locationId.push(locationId);
      parcels.status.push(parcelStatus);
      parcels.company.push(random.pick(COURIERS));
      parcels.trackingNumber.push(String(random.int(1e9, 1e10 - 1)));
      parcels.shippedAt.push(at(30));
      parcels.deliveredAt.push(parcelStatus === 'delivered' ? at(96) : null);
      parcels.returningAt.push(['returning', 'returned'].includes(parcelStatus) ? at(96) : null);
      parcels.returnedAt.push(parcelStatus === 'returned' ? at(200) : null);
      parcels.lostAt.push(parcelStatus === 'lost' ? at(300) : null);
    }

    const shipping = subtotal >= 500_000 ? 0 : 25_000;
    const total = subtotal + shipping;
    const paymentMethod =
      stage === 'awaiting_payment'
        ? 'bank_transfer'
        : random.weighted([
            ['cash_on_delivery', 88],
            ['bank_transfer', 8],
            ['prepaid', 4],
          ]);
    const paid =
      stage !== 'cancelled' &&
      (paymentMethod !== 'cash_on_delivery'
        ? stage !== 'awaiting_payment'
        : stage === 'completed' || (stage === 'delivered' && random.chance(0.7)));
    const confirmed = !['needs_confirmation', 'needs_review', 'cancelled'].includes(stage);
    const packed = confirmed && !['awaiting_payment', 'to_pack'].includes(stage);
    const status =
      stage === 'cancelled'
        ? 'cancelled'
        : ['completed', 'returned', 'lost'].includes(stage)
          ? 'closed'
          : 'open';
    const riskScore = random.chance(0.8) ? random.int(0, 100) : null;
    const address = {
      name: customer.name,
      phone: customer.phone,
      address1: `House ${random.int(1, 300)}, Street ${random.int(1, 40)}`,
      address2: random.pick(AREAS),
      landmark: random.chance(0.3) ? 'near Jamia Masjid' : null,
      city,
      provinceCode: province,
      zip: null,
    };
    orders.shopId.push(shopId);
    orders.id.push(orderId);
    orders.number.push(1000 + k);
    orders.source.push(random.weighted(SOURCES));
    orders.status.push(status);
    orders.confirmationStatus.push(
      stage === 'needs_confirmation'
        ? 'pending'
        : stage === 'needs_review'
          ? 'needs_review'
          : stage === 'cancelled'
            ? random.pick(['rejected', 'no_response', 'pending'])
            : 'confirmed',
    );
    orders.financialStatus.push(paid ? 'paid' : 'pending');
    orders.fulfillmentStatus.push(
      stage === 'returned' ? 'returned' : parcelStatus ? 'fulfilled' : 'unfulfilled',
    );
    orders.stage.push(stage);
    orders.paymentMethod.push(paymentMethod);
    orders.subtotal.push(subtotal);
    orders.shipping.push(shipping);
    orders.total.push(total);
    orders.amountPaid.push(paid ? total : 0);
    orders.codAmount.push(paymentMethod === 'cash_on_delivery' ? total : 0);
    orders.customerId.push(customer.id);
    orders.phone.push(customer.phone);
    orders.email.push(customer.email);
    orders.address.push(JSON.stringify(address));
    orders.locationId.push(locationId);
    orders.searchText.push(searchKey([customer.name, city, customer.email ?? ''].join(' ')));
    orders.cancelReason.push(
      stage === 'cancelled' ? random.pick(['customer', 'no_response', 'fraud', 'other']) : null,
    );
    orders.riskScore.push(riskScore);
    orders.riskLevel.push(
      riskScore === null ? null : riskScore < 40 ? 'low' : riskScore < 70 ? 'medium' : 'high',
    );
    orders.confirmedAt.push(confirmed ? at(2) : null);
    orders.packedAt.push(packed ? at(20) : null);
    orders.cancelledAt.push(stage === 'cancelled' ? at(4) : null);
    orders.paidAt.push(paid ? at(paymentMethod === 'cash_on_delivery' ? 150 : 1) : null);
    orders.closedAt.push(status === 'closed' ? at(320) : null);
    orders.createdAt.push(new Date(placed).toISOString());

    // Its timeline, as the services write one: placed, then each step it took, oldest first.
    // Drawn from what the order is, never from `random`, so the rest of the dataset stays as it was.
    const timeline: [hours: number, kind: string, message: string][] = [[0, 'created', 'Placed']];
    if (confirmed) timeline.push([2, 'confirmed', 'Confirmed by the customer on the phone']);
    if (stage === 'cancelled') timeline.push([4, 'cancelled', 'Cancelled']);
    if (packed) timeline.push([20, 'packed', 'Packed']);
    if (parcelStatus) timeline.push([30, 'fulfilled', `Shipped with ${parcels.company.at(-1)}`]);
    if (parcelStatus === 'delivered') timeline.push([96, 'delivered', 'Delivered']);
    if (parcelStatus === 'returning' || parcelStatus === 'returned') {
      timeline.push([96, 'returning', 'Refused at the door, on its way back']);
    }
    if (parcelStatus === 'returned') timeline.push([200, 'returned', 'Checked back in']);
    if (parcelStatus === 'lost') timeline.push([300, 'lost', 'Lost by the courier']);
    if (paid) {
      timeline.push([paymentMethod === 'cash_on_delivery' ? 150 : 1, 'paid', 'Marked as paid']);
    }
    timeline.sort((a, b) => a[0] - b[0]);
    for (const [hours, kind, message] of timeline) {
      rows.events.shopId.push(shopId);
      rows.events.id.push(newId());
      rows.events.orderId.push(orderId);
      rows.events.kind.push(kind);
      rows.events.message.push(message);
      rows.events.createdAt.push(at(hours));
    }
    // A comment on every fourth order, and a second on every twelfth, by its number: staff's
    // notes beside the events, which the timeline reads together.
    const comments: [hours: number, message: string][] = [];
    if (k % 4 === 0) comments.push([1, 'Called; she wants it after 5pm']);
    if (k % 12 === 0) comments.push([3, 'Asked for gift wrapping too']);
    for (const [hours, message] of comments) {
      rows.comments.shopId.push(shopId);
      rows.comments.id.push(newId());
      rows.comments.orderId.push(orderId);
      rows.comments.message.push(message);
      rows.comments.authorId.push(agentId);
      rows.comments.createdAt.push(at(hours));
    }
  }

  for (let k = 1; k <= cartCount; k++) {
    const wanted = Math.min(random.int(1, 4), variants.length);
    const chosen = new Set<SoldVariant>();
    while (chosen.size < wanted) chosen.add(random.pick(variants));
    const items = [...chosen].map((variant) => ({
      variantId: variant.id,
      quantity: random.int(1, 3),
      properties: {},
    }));
    rows.carts.shopId.push(shopId);
    rows.carts.id.push(newId());
    rows.carts.tokenHash.push(createHash('sha256').update(cartToken(shop.number, k)).digest());
    rows.carts.lines.push(JSON.stringify(items));
  }
}

/** Inserts `rows` in the caller's transaction, after the catalog rows they refer to. */
export async function insertSales(client: pg.PoolClient, rows: SalesRows): Promise<void> {
  const {
    locations,
    items,
    levels,
    customers,
    orders,
    lines,
    parcels,
    parcelLines,
    events,
    comments,
    carts,
  } = rows;
  await client.query(
    `INSERT INTO inventory.locations (shop_id, id, name, is_primary)
     SELECT shop_id, id, 'Warehouse', true FROM unnest($1::uuid[], $2::uuid[]) AS t(shop_id, id)`,
    [locations.shopId, locations.id],
  );
  await client.query(
    `INSERT INTO inventory.items (shop_id, variant_id, product_id, tracked)
     SELECT shop_id, variant_id, product_id, true
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(shop_id, variant_id, product_id)`,
    [items.shopId, items.variantId, items.productId],
  );
  await client.query(
    `INSERT INTO inventory.levels (shop_id, variant_id, location_id, on_hand)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::int[])`,
    [items.shopId, items.variantId, items.locationId, levels.onHand],
  );
  await client.query(
    `INSERT INTO customers.customers
       (shop_id, id, phone, name, email, search_text, created_at, updated_at)
     SELECT shop_id, id, phone, name, email, search_text, created_at, created_at
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::timestamptz[])
         AS t(shop_id, id, phone, name, email, search_text, created_at)`,
    [
      customers.shopId,
      customers.id,
      customers.phone,
      customers.name,
      customers.email,
      customers.searchText,
      customers.createdAt,
    ],
  );
  await client.query(
    `INSERT INTO customers.customer_phones (shop_id, phone, customer_id, created_at)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::timestamptz[])`,
    [customers.shopId, customers.phone, customers.id, customers.createdAt],
  );
  await client.query(
    `INSERT INTO orders.orders
       (shop_id, id, number, source, status, confirmation_status, financial_status,
        fulfillment_status, stage, payment_method, currency, subtotal, discount, shipping, total,
        amount_paid, cod_amount, customer_id, phone, email, shipping_address, location_id,
        search_text, cancel_reason, risk_score, risk_level, confirmed_at, packed_at, cancelled_at,
        paid_at, closed_at, created_at, updated_at)
     SELECT shop_id, id, number, source, status, confirmation_status, financial_status,
            fulfillment_status, stage, payment_method, 'PKR', subtotal, 0, shipping, total,
            amount_paid, cod_amount, customer_id, phone, email, address, location_id,
            search_text, cancel_reason, risk_score, risk_level, confirmed_at, packed_at,
            cancelled_at, paid_at, closed_at, created_at, created_at
       FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::bigint[], $12::bigint[],
                   $13::bigint[], $14::bigint[], $15::bigint[], $16::uuid[], $17::text[],
                   $18::text[], $19::jsonb[], $20::uuid[], $21::text[], $22::text[],
                   $23::smallint[], $24::text[], $25::timestamptz[], $26::timestamptz[],
                   $27::timestamptz[], $28::timestamptz[], $29::timestamptz[], $30::timestamptz[])
         AS t(shop_id, id, number, source, status, confirmation_status, financial_status,
              fulfillment_status, stage, payment_method, subtotal, shipping, total, amount_paid,
              cod_amount, customer_id, phone, email, address, location_id, search_text,
              cancel_reason, risk_score, risk_level, confirmed_at, packed_at, cancelled_at,
              paid_at, closed_at, created_at)`,
    [
      orders.shopId,
      orders.id,
      orders.number,
      orders.source,
      orders.status,
      orders.confirmationStatus,
      orders.financialStatus,
      orders.fulfillmentStatus,
      orders.stage,
      orders.paymentMethod,
      orders.subtotal,
      orders.shipping,
      orders.total,
      orders.amountPaid,
      orders.codAmount,
      orders.customerId,
      orders.phone,
      orders.email,
      orders.address,
      orders.locationId,
      orders.searchText,
      orders.cancelReason,
      orders.riskScore,
      orders.riskLevel,
      orders.confirmedAt,
      orders.packedAt,
      orders.cancelledAt,
      orders.paidAt,
      orders.closedAt,
      orders.createdAt,
    ],
  );
  await client.query(
    `INSERT INTO orders.lines
       (shop_id, id, order_id, position, variant_id, product_id, title, variant_title, sku,
        quantity, unit_price, total, fulfilled_quantity)
     SELECT shop_id, id, order_id, position, variant_id, product_id, title, variant_title, sku,
            quantity, unit_price, unit_price * quantity, fulfilled
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::int[], $5::uuid[], $6::uuid[],
                   $7::text[], $8::text[], $9::text[], $10::int[], $11::bigint[], $12::int[])
         AS t(shop_id, id, order_id, position, variant_id, product_id, title, variant_title,
              sku, quantity, unit_price, fulfilled)`,
    [
      lines.shopId,
      lines.id,
      lines.orderId,
      lines.position,
      lines.variantId,
      lines.productId,
      lines.title,
      lines.variantTitle,
      lines.sku,
      lines.quantity,
      lines.unitPrice,
      lines.fulfilled,
    ],
  );
  await client.query(
    `INSERT INTO orders.fulfillments
       (shop_id, id, order_id, location_id, status, tracking_company, tracking_number,
        shipped_at, delivered_at, returning_at, returned_at, lost_at, created_at, updated_at)
     SELECT shop_id, id, order_id, location_id, status, company, tracking_number, shipped_at,
            delivered_at, returning_at, returned_at, lost_at, shipped_at, shipped_at
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[],
                   $7::text[], $8::timestamptz[], $9::timestamptz[], $10::timestamptz[],
                   $11::timestamptz[], $12::timestamptz[])
         AS t(shop_id, id, order_id, location_id, status, company, tracking_number, shipped_at,
              delivered_at, returning_at, returned_at, lost_at)`,
    [
      parcels.shopId,
      parcels.id,
      parcels.orderId,
      parcels.locationId,
      parcels.status,
      parcels.company,
      parcels.trackingNumber,
      parcels.shippedAt,
      parcels.deliveredAt,
      parcels.returningAt,
      parcels.returnedAt,
      parcels.lostAt,
    ],
  );
  await client.query(
    `INSERT INTO orders.fulfillment_lines (shop_id, fulfillment_id, line_id, quantity)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::int[])`,
    [parcelLines.shopId, parcelLines.parcelId, parcelLines.lineId, parcelLines.quantity],
  );
  await client.query(
    `INSERT INTO orders.order_events (shop_id, id, order_id, kind, message, actor_kind, created_at)
     SELECT shop_id, id, order_id, kind, message, 'system', created_at
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::timestamptz[])
         AS t(shop_id, id, order_id, kind, message, created_at)`,
    [events.shopId, events.id, events.orderId, events.kind, events.message, events.createdAt],
  );
  await client.query(
    `INSERT INTO orders.order_comments
       (shop_id, id, order_id, message, author_kind, author_id, created_at)
     SELECT shop_id, id, order_id, message, 'staff', author_id, created_at
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::timestamptz[])
         AS t(shop_id, id, order_id, message, author_id, created_at)`,
    [
      comments.shopId,
      comments.id,
      comments.orderId,
      comments.message,
      comments.authorId,
      comments.createdAt,
    ],
  );
  await client.query(
    `INSERT INTO checkout.carts (shop_id, id, token_hash, lines, expires_at)
     SELECT shop_id, id, token_hash, lines, now() + interval '10 days'
       FROM unnest($1::uuid[], $2::uuid[], $3::bytea[], $4::jsonb[])
         AS t(shop_id, id, token_hash, lines)`,
    [carts.shopId, carts.id, carts.tokenHash, carts.lines],
  );
}
