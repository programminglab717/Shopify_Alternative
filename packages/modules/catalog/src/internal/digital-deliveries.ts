import { createHash, randomBytes } from 'node:crypto';
import { shopProfile } from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { Controller, Get, Inject, Injectable, Optional, Param, Res } from '@nestjs/common';
import { ObjectStorage } from '@hatti/storage';
import { sql } from 'drizzle-orm';

// Digital products delivered (CAT-13, ADR-814): once an order is paid, each of its lines of a
// digital product is given a link of its own, /dl/<secret>, to a page of the product's files.
// Each file downloads as many times as the product allows for each unit, until the link's days
// are over, through a URL storage signs for five minutes, saved as a download.

export const DOWNLOAD_LINK_PATH = 'dl';

/** What the controller asks of the host's HTTP reply: Fastify's, as the core runs it. */
interface Reply {
  code(status: number): Reply;
  headers(values: Record<string, string>): Reply;
  header(name: string, value: string): Reply;
  send(body?: string): unknown;
}

/** How long a file's signed URL works once asked for: five minutes. */
const DOWNLOAD_SECONDS = 300;

/** A link's secret: 32 random bytes, in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (token: string) => createHash('sha256').update(token).digest();

/** A line of a digital product to deliver, once its order is paid. */
export interface DigitalLine {
  orderId: string;
  lineItemId: string;
  productId: string;
  units: number;
  /** Each unit's downloads of each file, and the link's days, as the product says. */
  downloadLimit: number;
  linkDays: number;
}

/**
 * Gives the line a link to its product's files, in the caller's transaction, once: the link's
 * secret, to send the buyer; null where the line has one already, whose secret is not kept.
 */
export async function deliverDigitalIn(
  tx: Tx,
  shopId: string,
  line: DigitalLine,
  at: Date = new Date(),
): Promise<string | null> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await tx.execute(sql`
    INSERT INTO catalog.digital_deliveries
           (shop_id, token_hash, order_id, line_item_id, product_id, units, download_limit,
            expires_at, created_at)
    VALUES (${shopId}, ${sha256(token)}, ${line.orderId}, ${line.lineItemId}, ${line.productId},
            ${line.units}, ${line.downloadLimit * line.units},
            ${new Date(at.getTime() + line.linkDays * 86_400_000).toISOString()},
            ${at.toISOString()})
    ON CONFLICT (shop_id, line_item_id) DO NOTHING
    RETURNING id`);
  return rows.length > 0 ? token : null;
}

/** A link's page: the shop, the product, its files with the downloads each has left. */
export interface DownloadView {
  shopName: string;
  productTitle: string;
  expiresAt: Date;
  expired: boolean;
  files: { id: string; filename: string; size: number; left: number }[];
}

type DeliveryRow = {
  id: string;
  product_id: string;
  download_limit: number;
  expires_at: string | Date;
  title: string | null;
};

@Injectable()
export class DigitalDeliveryService {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(ObjectStorage) private readonly storage?: ObjectStorage | null,
  ) {}

  /** The delivery a link's secret names, and its shop: null for none. */
  async #find(token: string): Promise<{ shopId: string; deliveryId: string } | null> {
    if (!TOKEN.test(token)) return null;
    const { rows } = await this.db.app.execute<{ shop_id: string; delivery_id: string }>(
      sql`SELECT shop_id, delivery_id FROM catalog.resolve_digital_delivery(${sha256(token)})`,
    );
    return rows[0] ? { shopId: rows[0].shop_id, deliveryId: rows[0].delivery_id } : null;
  }

  /** What a link's page shows; null for a secret that is none. */
  async view(token: string, at: Date = new Date()): Promise<DownloadView | null> {
    const found = await this.#find(token);
    if (!found) return null;
    const { shopId, deliveryId } = found;
    return this.db.tenant(shopId, async (tx) => {
      const delivery = await deliveryIn(tx, shopId, deliveryId);
      if (!delivery) return null;
      const { rows: files } = await tx.execute<{
        id: string;
        filename: string;
        size: string;
        count: number | null;
      }>(sql`
        SELECT f.id, f.filename, f.size::text, d.count
          FROM catalog.digital_files f
          LEFT JOIN catalog.digital_downloads d
            ON d.shop_id = f.shop_id AND d.delivery_id = ${deliveryId} AND d.file_id = f.id
         WHERE f.shop_id = ${shopId} AND f.product_id = ${delivery.product_id}
           AND f.status = 'ready'
         ORDER BY f.created_at, f.id`);
      const expiresAt = toDate(delivery.expires_at);
      return {
        shopName: (await shopProfile(tx, shopId)).name,
        productTitle: delivery.title ?? '',
        expiresAt,
        expired: expiresAt.getTime() <= at.getTime(),
        files: files.map((file) => ({
          id: file.id,
          filename: file.filename,
          size: Number(file.size),
          left: Math.max(delivery.download_limit - (file.count ?? 0), 0),
        })),
      };
    });
  }

  /**
   * A download of one of a link's files: counted, and a URL storage signs for five minutes; why
   * not where the link is over, the file's downloads are used up, or there is no such file.
   */
  async download(
    token: string,
    fileId: string,
    at: Date = new Date(),
  ): Promise<{ url: string } | { refused: 'none' | 'expired' | 'used_up' }> {
    const storage = this.storage;
    const found = await this.#find(token);
    if (!found || !storage || !/^[0-9a-f-]{36}$/.test(fileId)) return { refused: 'none' };
    const { shopId, deliveryId } = found;
    return this.db.tenant(shopId, async (tx) => {
      const delivery = await deliveryIn(tx, shopId, deliveryId);
      if (!delivery) return { refused: 'none' as const };
      if (toDate(delivery.expires_at).getTime() <= at.getTime()) {
        return { refused: 'expired' as const };
      }
      const { rows: files } = await tx.execute<{ key: string; filename: string }>(sql`
        SELECT key, filename FROM catalog.digital_files
         WHERE shop_id = ${shopId} AND id = ${fileId} AND product_id = ${delivery.product_id}
           AND status = 'ready'`);
      const file = files[0];
      if (!file) return { refused: 'none' as const };
      // Counted where there are downloads left; none counted, none given.
      const { rows: counted } = await tx.execute(sql`
        INSERT INTO catalog.digital_downloads (shop_id, delivery_id, file_id, count)
        VALUES (${shopId}, ${deliveryId}, ${fileId}, 1)
        ON CONFLICT (shop_id, delivery_id, file_id) DO UPDATE
           SET count = catalog.digital_downloads.count + 1
         WHERE catalog.digital_downloads.count < ${delivery.download_limit}
        RETURNING count`);
      if (counted.length === 0) return { refused: 'used_up' as const };
      return {
        url: storage.signDownload(file.key, DOWNLOAD_SECONDS, {
          filename: file.filename,
          attachment: true,
        }),
      };
    });
  }
}

async function deliveryIn(
  tx: Tx,
  shopId: string,
  deliveryId: string,
): Promise<DeliveryRow | undefined> {
  const { rows } = await tx.execute<DeliveryRow>(sql`
    SELECT d.id, d.product_id, d.download_limit, d.expires_at, p.title
      FROM catalog.digital_deliveries d
      LEFT JOIN catalog.products p ON p.shop_id = d.shop_id AND p.id = d.product_id
     WHERE d.shop_id = ${shopId} AND d.id = ${deliveryId}`);
  return rows[0];
}

/** The page's words, in English and Urdu: the buyer's language is not known here. */
const WORDS = {
  title: 'Your downloads · آپ کی ڈاؤن لوڈز',
  left: (left: number) => `${left} left · ${left} باقی`,
  usedUp: 'Downloaded as often as it may be · جتنی بار ہو سکتا تھا ڈاؤن لوڈ ہو چکا',
  expired:
    'This link is over: ask the shop for another · یہ لنک ختم ہو چکا ہے: دکان سے نیا لنک مانگیں',
  until: (date: string) => `The link works until ${date} · یہ لنک ${date} تک چلے گا`,
  none: 'There is nothing to download here · یہاں ڈاؤن لوڈ کے لیے کچھ نہیں',
  refused: {
    none: 'There is nothing to download here · یہاں ڈاؤن لوڈ کے لیے کچھ نہیں',
    expired:
      'This link is over: ask the shop for another · یہ لنک ختم ہو چکا ہے: دکان سے نیا لنک مانگیں',
    used_up: 'Downloaded as often as it may be · جتنی بار ہو سکتا تھا ڈاؤن لوڈ ہو چکا',
  },
} as const;

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A file's weight as people read it: 1.2 MB. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** A link's page, plain HTML, with nothing to load from anywhere. */
export function downloadPage(view: DownloadView | null, token: string, message?: string): string {
  const body = !view
    ? `<p>${escape(WORDS.none)}</p>`
    : [
        `<p class="shop">${escape(view.shopName)}</p>`,
        `<h1>${escape(view.productTitle)}</h1>`,
        message ? `<p class="note" role="alert">${escape(message)}</p>` : '',
        view.expired
          ? `<p class="note">${escape(WORDS.expired)}</p>`
          : `<p>${escape(WORDS.until(view.expiresAt.toISOString().slice(0, 10)))}</p>`,
        view.files.length === 0
          ? `<p>${escape(WORDS.none)}</p>`
          : `<ul>${view.files
              .map((file) =>
                !view.expired && file.left > 0
                  ? `<li><a href="${escape(token)}/${file.id}" download>${escape(file.filename)}</a> <span>${sizeOf(file.size)} · ${escape(WORDS.left(file.left))}</span></li>`
                  : `<li>${escape(file.filename)} <span>${escape(file.left > 0 ? WORDS.expired : WORDS.usedUp)}</span></li>`,
              )
              .join('')}</ul>`,
      ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(WORDS.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:0 auto;padding:1rem;color:#111}h1{font-size:1.25rem}.shop{color:#555;margin:0}ul{list-style:none;padding:0}li{padding:.75rem 0;border-bottom:1px solid #ddd}a{font-weight:600}span{display:block;color:#555;font-size:.875rem}.note{background:#fff4e5;padding:.5rem .75rem;border-radius:.5rem}</style></head><body>${body}</body></html>`;
}

/**
 * Sent with every answer: the address carries the link's secret, so the page is never cached,
 * indexed or framed, and browsers send its address to no other site.
 */
const PRIVATE_PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * A digital order line's link (ADR-814): GET /dl/<secret> shows its files with the downloads
 * each has left; GET /dl/<secret>/<file> counts one and sends the browser to the file, saved as a
 * download, or back to the page saying why not.
 */
@Controller(DOWNLOAD_LINK_PATH)
export class DigitalDownloadController {
  constructor(private readonly deliveries: DigitalDeliveryService) {}

  @Get(':token')
  async show(@Param('token') token: string, @Res() reply: Reply): Promise<void> {
    const view = await this.deliveries.view(token);
    await reply
      .code(view ? 200 : 404)
      .headers(PRIVATE_PAGE_HEADERS)
      .header('content-type', 'text/html; charset=utf-8')
      .send(downloadPage(view, token));
  }

  @Get(':token/:file')
  async download(
    @Param('token') token: string,
    @Param('file') file: string,
    @Res() reply: Reply,
  ): Promise<void> {
    const result = await this.deliveries.download(token, file);
    if ('url' in result) {
      await reply.code(303).headers(PRIVATE_PAGE_HEADERS).header('location', result.url).send();
      return;
    }
    const view = await this.deliveries.view(token);
    await reply
      .code(result.refused === 'none' ? 404 : 410)
      .headers(PRIVATE_PAGE_HEADERS)
      .header('content-type', 'text/html; charset=utf-8')
      .send(downloadPage(view, token, WORDS.refused[result.refused]));
  }
}
