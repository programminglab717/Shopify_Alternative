import {
  failOne,
  phoneAccess,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { html, renderDocument, type Html, type Language, type Paper } from '@hatti/documents';
import { LocationService } from '@hatti/inventory/public';
import type { CurrencyCode } from '@hatti/money';
import { parcelShipmentFactsIn } from '@hatti/orders/public';
import { maskPkMobile, parsePkMobile } from '@hatti/pk';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  BOOKING_COLUMNS,
  BOOKING_FROM,
  BOOKING_LIMITS,
  bookingRecordOf,
  bookingsIn,
  type BookingRow,
  type CourierBookingRecord,
} from './bookings.service.js';
import { COURIERS } from './courier-accounts.service.js';
import {
  loadSheet,
  shippingLabel,
  type CourierDocumentContext,
  type LoadSheetRow,
  type ParcelLabel,
} from './courier-documents.js';
import type { Couriers } from './couriers.js';

/** Labels print on 4×6 inch labels, one a page, or on A4, four a sheet. */
export const LABEL_PAPERS: readonly Paper[] = ['thermal_4x6', 'a4'];

/** Parcels a load sheet lists at most, the longest waiting first. */
export const LOAD_SHEET_LIMIT = 1_000;

/** A document for couriers, ready to print. */
export interface CourierDocumentRecord {
  /** A complete HTML page. */
  html: string;
  title: string;
  fileName: string;
  /** The bookings in it, in the order printed. */
  bookings: CourierBookingRecord[];
}

/**
 * Couriers' labels and load sheets for the parcels the worker booked (SHP-02, ADR-150), printed
 * from the browser as the order's other documents are: the courier's tracking number as a Code
 * 128 barcode, and the cash the courier was asked to collect.
 */
@Injectable()
export class CourierDocumentService {
  constructor(
    private readonly db: Database,
    @Inject(COURIERS) private readonly couriers: Couriers,
    private readonly locations: LocationService,
  ) {}

  /**
   * Labels for the bookings `ids` booked with their couriers, in the order given: on 4×6 inch
   * labels, one a page, or on A4, four a sheet. Bookings not booked, or whose customer's details
   * were erased, are left out. Customers' numbers show as the caller sees them elsewhere.
   */
  async labels(
    tenant: TenantContext,
    ids: readonly string[],
    request: { paper: Paper; language: Language },
  ): Promise<MutationResult<CourierDocumentRecord>> {
    if (ids.length === 0) return failOne(['ids'], 'BLANK', 'Ids must include at least one');
    if (ids.length > BOOKING_LIMITS.orders) {
      return failOne(['ids'], 'TOO_MANY', `Ids can have at most ${BOOKING_LIMITS.orders}`);
    }
    if (!LABEL_PAPERS.includes(request.paper)) {
      return failOne(['paper'], 'INVALID', 'Labels print on 4×6 inch labels or on A4');
    }
    const wanted = [...new Set(ids)];
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = new Map(
        (await bookingsIn(tx, tenant.shopId, wanted)).map((row) => [row.id, row]),
      );
      const booked = wanted.flatMap((id) => {
        const row = rows.get(id);
        return row?.status === 'booked' && row.fulfillment_id && row.tracking_number ? [row] : [];
      });
      const parcels = await parcelShipmentFactsIn(
        tx,
        tenant.shopId,
        booked.map((row) => row.fulfillment_id!),
      );
      const labels: { row: BookingRow; label: ParcelLabel }[] = [];
      for (const row of booked) {
        const parcel = parcels.get(row.fulfillment_id!);
        if (!parcel?.address) continue;
        labels.push({
          row,
          label: {
            courierName: this.#courierName(row.courier),
            trackingNumber: row.tracking_number!,
            codAmount: BigInt(row.cod_amount ?? '0'),
            bookedAt: toDate(row.booked_at!),
            parcel: { ...parcel, address: parcel.address },
            phone: shownNumber(tenant, parcel.address.phone),
          },
        });
      }
      if (labels.length === 0) {
        return failOne(
          ['ids'],
          'INVALID',
          'None of these bookings has been booked with its courier yet',
        );
      }
      const context = await this.#context(
        tx,
        tenant,
        request.language,
        labels.map(({ label }) => label.parcel.locationId),
      );
      const drawn = labels.map(({ label }) => shippingLabel(label, context));
      const pages: Html[] =
        request.paper === 'a4' ? chunks(drawn, 4).map((sheet) => html4Up(sheet)) : drawn;
      const numbers = labels.map(({ row }) => row.order_number);
      const title =
        labels.length === 1 ? `Label #${numbers[0]}` : `Labels: ${labels.length} parcels`;
      const fileName =
        labels.length === 1
          ? `label-${numbers[0]}.html`
          : `labels-${Math.min(...numbers)}-${Math.max(...numbers)}.html`;
      return {
        ok: true,
        value: {
          html: renderDocument({ title, paper: request.paper, language: request.language, pages }),
          title,
          fileName,
          bookings: labels.map(({ row }) => bookingRecordOf(row, this.couriers)),
        },
      };
    });
  }

  /**
   * The load sheet of a courier account, the default unless given: its parcels waiting to be
   * picked up, the longest waiting first, up to {@link LOAD_SHEET_LIMIT}, with their cash and
   * boxes for the shop and the rider to sign. On A4.
   */
  async loadSheet(
    tenant: TenantContext,
    request: { accountId?: string | null; language: Language; at?: Date },
  ): Promise<MutationResult<CourierDocumentRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: accounts } = await tx.execute<{
        id: string;
        courier: string;
        name: string;
        pickup_code: string | null;
      }>(sql`
        SELECT id, courier, name, pickup_code FROM logistics.courier_accounts
         WHERE shop_id = ${tenant.shopId}
           AND ${request.accountId ? sql`id = ${request.accountId}` : sql`is_default`}`);
      const account = accounts[0];
      if (!account) {
        return request.accountId
          ? failOne(['accountId'], 'NOT_FOUND', 'Courier account not found')
          : failOne(['accountId'], 'BLANK', 'Connect a courier account first');
      }
      const { rows } = await tx.execute<BookingRow>(sql`
        SELECT ${BOOKING_COLUMNS}
          FROM ${BOOKING_FROM}
         WHERE b.shop_id = ${tenant.shopId} AND b.account_id = ${account.id}
           AND b.status = 'booked' AND b.parcel_status = 'booked'
         ORDER BY b.booked_at, b.id
         LIMIT ${LOAD_SHEET_LIMIT}`);
      if (rows.length === 0) {
        return failOne(
          ['accountId'],
          'INVALID',
          "None of this account's parcels waits to be picked up",
        );
      }
      const parcels = await parcelShipmentFactsIn(
        tx,
        tenant.shopId,
        rows.map((row) => row.fulfillment_id!),
      );
      const lines: LoadSheetRow[] = rows.map((row) => {
        const parcel = parcels.get(row.fulfillment_id!);
        return {
          trackingNumber: row.tracking_number!,
          orderNumber: row.order_number,
          customer: parcel?.address?.name ?? null,
          city: parcel?.address?.city ?? null,
          pieces: parcel?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
          codAmount: BigInt(row.cod_amount ?? '0'),
        };
      });
      const locationIds = [...parcels.values()].map((parcel) => parcel.locationId);
      const context = await this.#context(tx, tenant, request.language, locationIds);
      const at = request.at ?? new Date();
      const courierName = this.#courierName(account.courier);
      const page = loadSheet(
        lines,
        {
          account: { name: account.name, courierName, pickupCode: account.pickup_code },
          at,
          from: locationIds.length > 0 ? (context.locations.get(locationIds[0]!) ?? null) : null,
        },
        context,
      );
      const title = `Load sheet: ${account.name}`;
      const day = at.toISOString().slice(0, 10);
      return {
        ok: true,
        value: {
          html: renderDocument({
            title,
            paper: 'a4',
            language: request.language,
            pages: [page],
          }),
          title,
          fileName: `load-sheet-${account.courier}-${day}.html`,
          bookings: rows.map((row) => bookingRecordOf(row, this.couriers)),
        },
      };
    });
  }

  async #context(
    tx: Tx,
    tenant: TenantContext,
    language: Language,
    locationIds: readonly string[],
  ): Promise<CourierDocumentContext> {
    return {
      language,
      shop: await shopProfile(tx, tenant.shopId),
      currency: tenant.currency as CurrencyCode,
      locations: await this.locations.locationsOf(tx, tenant.shopId, locationIds),
    };
  }

  #courierName(courier: string): string {
    return this.couriers.of(courier)?.info.name ?? courier;
  }
}

/** Four labels on a sheet of A4, two by two. */
function html4Up(labels: readonly Html[]): Html {
  return html`<div class="labels">${labels}</div>`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** "0300 1234567" for callers who see numbers whole, "0300 ••••567" for the rest. */
function shownNumber(tenant: TenantContext, e164: string): string {
  if (phoneAccess(tenant) !== 'full') return maskPkMobile(e164);
  return parsePkMobile(e164)?.display ?? e164;
}
