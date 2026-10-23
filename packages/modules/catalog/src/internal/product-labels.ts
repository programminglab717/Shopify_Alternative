import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { code128, html, isCode128, ltr, renderDocument, text, type Html } from '@hatti/documents';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { VariantService } from './variant.service.js';

// Products' barcodes and the labels printed with them (CAT-22, ADR-757): a barcode of the
// shop's own for each variant without one, and price labels to stick on what it sells, each
// with its title, variant, price and barcode, on a sheet of A4 or a roll of labels.

/** How the labels are printed: 24 to a sheet of A4, three across, or one to a 50×25 mm label. */
export type LabelPaper = 'a4' | 'label_50x25';

/** Labels to a sheet of A4: three across and eight down, 70×37 mm each, as sheets come cut. */
const SHEET = 24;

/** The most labels made at once. */
export const LABELS_MAX = 1_000;

/** The most products given barcodes at once, as many as a page of the products list holds. */
export const BARCODE_PRODUCTS_MAX = 250;

/** A variant to label, and how many of its labels. */
export interface LabelRequest {
  variantId: string;
  copies: number;
}

/** What a label shows of its variant. */
export interface LabelFacts {
  productTitle: string;
  /** Its options' values; null for a product of one variant. */
  variantTitle: string | null;
  price: bigint;
  /** Shown struck through beside the price where it is more. */
  compareAtPrice: bigint | null;
  /** Its barcode, else its SKU, drawn as Code 128; null for neither, which prints without bars. */
  code: string | null;
}

/** EAN-13's check digit for its first twelve digits: weights 1 and 3 in turn, from the left. */
export function ean13CheckDigit(digits: string): number {
  if (!/^\d{12}$/.test(digits)) throw new Error('EAN-13 checks twelve digits');
  const sum = [...digits].reduce((total, digit, at) => total + Number(digit) * (at % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

/**
 * A barcode of the shop's own: an EAN-13 starting 2, which GS1 leaves for numbers used within a
 * business and never gives a manufacturer, so it cannot be another product's; eleven digits
 * drawn at random, then its check digit.
 */
export function shopBarcode(draw: (below: number) => number = randomInt): string {
  const digits = `2${Array.from({ length: 11 }, () => draw(10)).join('')}`;
  return `${digits}${ean13CheckDigit(digits)}`;
}

/** One label's markup. */
export function labelOf(facts: LabelFacts, currency: CurrencyCode): Html {
  const price = (amount: bigint) => formatMoney(money(amount, currency));
  const was =
    facts.compareAtPrice !== null && facts.compareAtPrice > facts.price
      ? html`<s>${price(facts.compareAtPrice)}</s>`
      : html``;
  const drawn = facts.code !== null && isCode128(facts.code);
  return html`<div class="tag">
    <p class="tag-title">${text(facts.productTitle)}</p>
    ${facts.variantTitle && html`<p class="tag-variant">${text(facts.variantTitle)}</p>`}
    <p class="tag-price">${ltr(price(facts.price))}${was}</p>
    ${drawn && code128(facts.code!)}
    ${facts.code && html`<p class="tag-code">${ltr(facts.code)}</p>`}
  </div>`;
}

/** The labels as a page to print: 24 to a sheet of A4, or one to a label of a roll. */
export function labelsDocument(
  labels: readonly LabelFacts[],
  paper: LabelPaper,
  currency: CurrencyCode,
): string {
  const tags = labels.map((facts) => labelOf(facts, currency));
  const pages: Html[] = [];
  if (paper === 'a4') {
    for (let at = 0; at < tags.length; at += SHEET) {
      pages.push(html`<div class="tags">${tags.slice(at, at + SHEET)}</div>`);
    }
  } else {
    pages.push(...tags);
  }
  return renderDocument({
    title: labels.length === 1 ? 'Label' : `${labels.length} labels`,
    paper,
    language: 'english',
    pages,
  });
}

@Injectable()
export class ProductLabelService {
  constructor(
    private readonly db: Database,
    private readonly variants: VariantService,
  ) {}

  /**
   * The labels of `requests`' variants, each as many times as asked, in the order asked, as a
   * page to print. A variant of another shop's, or none, is said by where it was asked.
   */
  async labels(
    tenant: TenantContext,
    requests: readonly LabelRequest[],
    paper: LabelPaper,
  ): Promise<MutationResult<{ title: string; html: string; labels: number }>> {
    if (requests.length === 0) return failOne(['items'], 'BLANK', 'Choose what to label');
    const badCopies = requests.findIndex(
      (request) => !Number.isInteger(request.copies) || request.copies < 1,
    );
    if (badCopies >= 0) {
      return failOne(['items', String(badCopies), 'copies'], 'INVALID', 'must be at least 1');
    }
    const total = requests.reduce((sum, request) => sum + request.copies, 0);
    if (total > LABELS_MAX) {
      return failOne(
        ['items'],
        'TOO_MANY',
        `At most ${LABELS_MAX.toLocaleString('en')} labels can be printed at once`,
      );
    }
    const facts = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        product_title: string;
        title: string;
        options: number;
        price: string;
        compare_at_price: string | null;
        barcode: string | null;
        sku: string | null;
      }>(sql`
        SELECT v.id, p.title AS product_title, v.title, v.price, v.compare_at_price, v.barcode,
               v.sku,
               (SELECT count(*) FROM catalog.variants o
                 WHERE o.shop_id = v.shop_id AND o.product_id = v.product_id)::int AS options
          FROM catalog.variants v
          JOIN catalog.products p ON p.shop_id = v.shop_id AND p.id = v.product_id
         WHERE v.shop_id = ${tenant.shopId}
           AND v.id = ANY(${sql.param(requests.map((request) => request.variantId))}::uuid[])`);
      return new Map(
        rows.map((row): [string, LabelFacts] => [
          row.id,
          {
            productTitle: row.product_title,
            variantTitle: row.options > 1 ? row.title : null,
            price: BigInt(row.price),
            compareAtPrice: row.compare_at_price === null ? null : BigInt(row.compare_at_price),
            code: row.barcode || row.sku || null,
          },
        ]),
      );
    });
    const missing = requests.findIndex((request) => !facts.has(request.variantId));
    if (missing >= 0) {
      return failOne(['items', String(missing), 'variantId'], 'NOT_FOUND', 'Variant not found');
    }
    const labels = requests.flatMap((request) =>
      Array.from({ length: request.copies }, () => facts.get(request.variantId)!),
    );
    return {
      ok: true,
      value: {
        title: labels.length === 1 ? 'Label' : `${labels.length} labels`,
        html: labelsDocument(labels, paper, tenant.currency),
        labels: labels.length,
      },
    };
  }

  /**
   * A barcode of the shop's own for each variant of `productIds` without one, none the same as
   * another of the shop's; those with barcodes keep them. Each product's variants are changed as
   * any change to them is, its events and all.
   */
  async giveBarcodes(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<MutationResult<{ given: number; had: number }>> {
    if (productIds.length > BARCODE_PRODUCTS_MAX) {
      return failOne(
        ['productIds'],
        'TOO_MANY',
        `At most ${BARCODE_PRODUCTS_MAX} products can be given barcodes at once`,
      );
    }
    const found = await this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string; product_id: string; barcode: string | null }>(
        sql`SELECT id, product_id, barcode FROM catalog.variants
             WHERE shop_id = ${tenant.shopId}
               AND product_id = ANY(${sql.param([...productIds])}::uuid[])
             ORDER BY product_id, position`,
      );
      return rows;
    });
    const without = found.filter((row) => !row.barcode?.trim());
    const codes = await this.#unusedBarcodes(tenant, without.length);
    const byProduct = new Map<string, { id: string; barcode: string }[]>();
    without.forEach((row, at) => {
      const list = byProduct.get(row.product_id) ?? [];
      list.push({ id: row.id, barcode: codes[at]! });
      byProduct.set(row.product_id, list);
    });
    for (const [productId, inputs] of byProduct) {
      const updated = await this.variants.bulkUpdate(tenant, productId, inputs);
      if (!updated.ok) return updated;
    }
    return { ok: true, value: { given: without.length, had: found.length - without.length } };
  }

  /** `count` barcodes of the shop's own that none of its variants has, nor each other. */
  async #unusedBarcodes(tenant: TenantContext, count: number): Promise<string[]> {
    const chosen = new Set<string>();
    while (chosen.size < count) {
      const candidates = new Set<string>();
      while (candidates.size < count - chosen.size) {
        const code = shopBarcode();
        if (!chosen.has(code)) candidates.add(code);
      }
      const taken = await this.db.tenant(tenant.shopId, async (tx) => {
        const { rows } = await tx.execute<{ barcode: string }>(sql`
          SELECT barcode FROM catalog.variants
           WHERE shop_id = ${tenant.shopId}
             AND barcode = ANY(${sql.param([...candidates])}::text[])`);
        return new Set(rows.map((row) => row.barcode));
      });
      for (const code of candidates) if (!taken.has(code)) chosen.add(code);
    }
    return [...chosen];
  }
}
