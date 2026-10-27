import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { LocalStorage } from '@hatti/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DigitalDeliveryService,
  deliverDigitalIn,
  downloadPage,
  type DigitalLine,
} from './digital-deliveries.js';
import { DigitalProductService } from './digital-products.js';
import { catalogFixture, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

const AT = new Date('2026-10-27T09:00:00Z');

describe.skipIf(!server)("Digital products' links to their files (CAT-13, ADR-814)", () => {
  let f: CatalogFixture;
  let directory: string;
  let storage: LocalStorage;
  let deliveries: DigitalDeliveryService;
  let digital: DigitalProductService;

  beforeAll(async () => {
    f = await catalogFixture(server!);
    directory = await mkdtemp(join(tmpdir(), 'deliveries-'));
    storage = new LocalStorage({
      directory,
      baseUrl: 'http://localhost:4000/storage',
      secret: 'a'.repeat(32),
    });
    deliveries = new DigitalDeliveryService(f.db, storage);
    digital = new DigitalProductService(f.db, storage);
  }, 120_000);
  afterAll(async () => {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => f.reset());

  /** A digital product with a file uploaded and ready, and a line of `units` of it. */
  async function sold(units: number): Promise<{ line: DigitalLine; fileId: string }> {
    const productId = unwrap(
      await f.products.create(f.a, { title: 'Embroidery patterns', status: 'active' }),
    ).id;
    unwrap(await digital.set(f.a, productId, { downloadLimit: 2, linkDays: 7 }));
    const staged = unwrap(
      await digital.fileStage(f.a, productId, {
        filename: 'patterns.pdf',
        contentType: 'application/pdf',
        size: 11,
      }),
    );
    const { rows } = await f.admin.query<{ key: string }>(
      'SELECT key FROM catalog.digital_files WHERE id = $1',
      [staged.file.id],
    );
    await storage.put(rows[0]!.key, Buffer.from('%PDF-1.7 hi'), 'application/pdf');
    unwrap(await digital.fileCreate(f.a, staged.file.id));
    return {
      line: {
        orderId: newId(),
        lineItemId: newId(),
        productId,
        units,
        downloadLimit: 2,
        linkDays: 7,
      },
      fileId: staged.file.id,
    };
  }

  it("shows a line's files and downloads each as often as its units allow, saved as a download", async () => {
    const { line, fileId } = await sold(2);
    const token = (await f.db.tenant(f.a.shopId, (tx) =>
      deliverDigitalIn(tx, f.a.shopId, line, AT),
    ))!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Once a line: the second time, no new link.
    expect(
      await f.db.tenant(f.a.shopId, (tx) => deliverDigitalIn(tx, f.a.shopId, line, AT)),
    ).toBeNull();

    const soon = new Date(AT.getTime() + 60_000);
    expect(await deliveries.view(token, soon)).toEqual({
      shopName: expect.any(String),
      productTitle: 'Embroidery patterns',
      expiresAt: new Date(AT.getTime() + 7 * 86_400_000),
      expired: false,
      files: [{ id: fileId, filename: 'patterns.pdf', size: 11, left: 4 }],
    });
    // Two units, two downloads each: four in all.
    for (let time = 0; time < 4; time++) {
      const got = await deliveries.download(token, fileId, soon);
      if (!('url' in got)) throw new Error(JSON.stringify(got));
      const { searchParams } = new URL(got.url);
      expect(searchParams.get('attachment')).toBe('1');
    }
    expect(await deliveries.download(token, fileId, soon)).toEqual({ refused: 'used_up' });
    expect((await deliveries.view(token, soon))!.files[0]!.left).toBe(0);
    // Past its days: over.
    const late = new Date(AT.getTime() + 8 * 86_400_000);
    expect((await deliveries.view(token, late))!.expired).toBe(true);
    expect(await deliveries.download(token, fileId, late)).toEqual({ refused: 'expired' });
  });

  it('knows no secret that is none, no file of another product, and no closed shop', async () => {
    const { line, fileId } = await sold(1);
    const token = (await f.db.tenant(f.a.shopId, (tx) =>
      deliverDigitalIn(tx, f.a.shopId, line, AT),
    ))!;
    expect(await deliveries.view('x'.repeat(43), AT)).toBeNull();
    expect(await deliveries.view('short', AT)).toBeNull();
    expect(await deliveries.download(token, newId(), AT)).toEqual({ refused: 'none' });
    expect(await deliveries.download('x'.repeat(43), fileId, AT)).toEqual({ refused: 'none' });
    await f.admin.query(`UPDATE control.shops SET status = 'suspended' WHERE id = $1`, [
      f.a.shopId,
    ]);
    expect(await deliveries.view(token, AT)).toBeNull();
    await f.admin.query(`UPDATE control.shops SET status = 'active' WHERE id = $1`, [f.a.shopId]);
  });

  it('writes its page plainly, each name escaped, links relative to the secret', () => {
    const view = {
      shopName: 'Zari <Fashions>',
      productTitle: 'Patterns & more',
      expiresAt: new Date('2026-11-03T09:00:00Z'),
      expired: false,
      files: [
        { id: 'f1', filename: 'a"b.pdf', size: 2_500_000, left: 3 },
        { id: 'f2', filename: 'done.zip', size: 10, left: 0 },
      ],
    };
    const html = downloadPage(view, 'TOKEN');
    expect(html).toContain('<p class="shop">Zari &#60;Fashions&#62;</p>');
    expect(html).toContain('<h1>Patterns &#38; more</h1>');
    expect(html).toContain('<a href="TOKEN/f1" download>a&#34;b.pdf</a>');
    expect(html).toContain('2.4 MB · 3 left');
    expect(html).toContain('<li>done.zip <span>Downloaded as often as it may be');
    expect(html).toContain('until 2026-11-03');
    expect(downloadPage(null, 'TOKEN')).toContain('There is nothing to download here');
  });
});
