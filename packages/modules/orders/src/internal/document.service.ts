import {
  failOne,
  phoneAccess,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { renderDocument, type Language, type Paper } from '@hatti/documents';
import { LocationService } from '@hatti/inventory/public';
import { maskPkMobile, parsePkMobile } from '@hatti/pk';
import { fiscalInvoicesIn, taxSettingsIn, type FiscalInvoiceRecord } from '@hatti/tax/public';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  creditNotes,
  documentName,
  invoice,
  packingSlip,
  type DocumentKindValue,
} from './documents.js';
import { invoicesIn, issueInvoicesIn, type OrderInvoiceRecord } from './invoice-series.js';
import { loadOrders } from './order-store.js';
import type { OrderRecord } from './records.js';
import { OVER_LIMIT_MESSAGE } from './plan-orders.js';
import { LIMITS, orderName } from './rules.js';

export interface DocumentRequest {
  kind: DocumentKindValue;
  paper: Paper;
  language: Language;
}

/** Packing slips or invoices, ready to print. */
export interface OrderDocumentRecord {
  /** A complete HTML page, with each order on a page of its own. */
  html: string;
  title: string;
  fileName: string;
  /** The orders in it, in the order asked for. */
  orders: OrderRecord[];
}

@Injectable()
export class OrderDocumentService {
  constructor(
    private readonly db: Database,
    private readonly locations: LocationService,
  ) {}

  /**
   * One document for up to {@link LIMITS.batch} orders, a page each, in the order given; an ID
   * given twice counts once, and IDs of no order of the shop are left out. Customers' numbers
   * show as the caller sees them elsewhere: whole for owners and managers, masked for other staff.
   */
  async render(
    tenant: TenantContext,
    ids: readonly string[],
    request: DocumentRequest,
  ): Promise<MutationResult<OrderDocumentRecord>> {
    if (ids.length === 0) return failOne(['ids'], 'BLANK', 'Ids must include at least one');
    if (ids.length > LIMITS.batch) {
      return failOne(['ids'], 'TOO_MANY', `Ids can have at most ${LIMITS.batch}`);
    }
    const wanted = [...new Set(ids)];
    const { shop, registration, orders, locations, invoices, fiscal } = await this.db.tenant(
      tenant.shopId,
      async (tx) => {
        const found = await loadOrders(tx, tenant.shopId, {
          where: sql`o.id = ANY(${sql.param(wanted)}::uuid[])`,
        });
        const byId = new Map(found.map((order) => [order.id, order]));
        const orders = wanted.flatMap((id) => byId.get(id) ?? []);
        const locationIds = orders.map((order) => order.locationId);
        const shop = await shopProfile(tx, tenant.shopId);
        // An invoice printed is issued (ADR-495): those of orders without one take the next
        // numbers, unless an order in the batch is past the plan's limit and nothing prints.
        const printable = orders.every((order) => order.overLimitAt === null);
        const ids = orders.map((order) => order.id);
        const invoices: Map<string, OrderInvoiceRecord> = !printable
          ? new Map()
          : request.kind === 'invoice'
            ? await issueInvoicesIn(tx, tenant.shopId, orders, shop.timezone)
            : request.kind === 'credit_note'
              ? await invoicesIn(tx, tenant.shopId, ids)
              : new Map();
        // How they stand with FBR, where the shop's POS was connected (ADR-556).
        const numbers = [
          ...[...invoices.values()].map((invoice) => invoice.name),
          ...orders.flatMap((order) =>
            order.refunds.flatMap((refund) => refund.creditNote?.name ?? []),
          ),
        ];
        return {
          shop,
          registration: await taxSettingsIn(tx, tenant.shopId),
          orders,
          locations: await this.locations.locationsOf(tx, tenant.shopId, locationIds),
          invoices,
          fiscal: await fiscalInvoicesIn(tx, tenant.shopId, numbers),
        };
      },
    );

    // Their customers stay hidden until the shop's plan has room for them (ADR-263).
    const over = orders.filter((order) => order.overLimitAt !== null);
    if (over.length > 0) {
      const names = over.map((order) => orderName(order.number)).join(', ');
      return failOne(['ids'], 'INVALID', `${names}: ${OVER_LIMIT_MESSAGE}`);
    }
    const pages = orders.flatMap((order) => {
      const context = {
        language: request.language,
        shop,
        from: locations.get(order.locationId) ?? null,
        phone: shownNumber(tenant, order.phone),
        registration,
        invoice: invoices.get(order.id) ?? null,
        fiscal,
      };
      if (request.kind === 'credit_note') return creditNotes(order, context);
      return [(request.kind === 'invoice' ? invoice : packingSlip)(order, context)];
    });
    if (request.kind === 'credit_note' && pages.length === 0 && orders.length > 0) {
      return failOne(['ids'], 'INVALID', 'No credit note has been issued for these orders');
    }
    const { title, fileName } = documentName(
      request.kind,
      orders.map((order) => order.number),
    );
    const html = renderDocument({ title, paper: request.paper, language: request.language, pages });
    return { ok: true, value: { html, title, fileName, orders } };
  }

  /**
   * The invoices issued for orders `ids`, by order (ADR-495), with how each stands with FBR where
   * the shop's POS was connected when it was issued (ADR-556).
   */
  async invoicesOf(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, OrderInvoiceRecord & { fiscal: FiscalInvoiceRecord | null }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const invoices = await invoicesIn(tx, tenant.shopId, ids);
      const fiscal = await fiscalInvoicesIn(
        tx,
        tenant.shopId,
        [...invoices.values()].map((invoice) => invoice.name),
      );
      return new Map(
        [...invoices].map(([id, invoice]) => [
          id,
          { ...invoice, fiscal: fiscal.get(invoice.name) ?? null },
        ]),
      );
    });
  }
}

/** "0300 1234567" for callers who see numbers whole, "0300 ••••567" for the rest. */
function shownNumber(tenant: TenantContext, e164: string | null): string | null {
  if (!e164) return null;
  if (phoneAccess(tenant) !== 'full') return maskPkMobile(e164);
  return parsePkMobile(e164)?.display ?? e164;
}
