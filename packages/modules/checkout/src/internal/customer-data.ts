import { CustomerDataRegistry, type CustomerDataHandler } from '@hatti/customers/public';
import { toDate } from '@hatti/db';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';

/**
 * Checkout's part in erasing and exporting customers (ADR-199): the browsers that proved their
 * numbers lately, kept by number. An erased customer's proofs go; a customer's own file says when
 * each of their numbers was proved, and until when it spares them a code. Nothing is merged:
 * proofs are kept by number, not by customer. Codes sent in a checkout go with it, within hours.
 * Checkouts they left after typing their number (ADR-393) lose what they typed, and are in their
 * file. So do the sessions signed in to their account on the storefront with one of their numbers
 * (ADR-570): erased, they go, and their codes to sign in with; merged, the customer kept is the one
 * they read.
 */
export const CHECKOUT_CUSTOMER_DATA: CustomerDataHandler = {
  key: 'checkout',

  async erasureBlockers() {
    return [];
  },

  async merge(tx, shopId, fromId, intoId) {
    // Sessions signed in to the duplicate's account read the customer's now (ADR-570).
    await tx.execute(sql`
      UPDATE checkout.account_sessions SET customer_id = ${intoId}
       WHERE shop_id = ${shopId} AND customer_id = ${fromId}`);
  },

  async erase(tx, shopId, customer) {
    await tx.execute(sql`
      DELETE FROM checkout.number_proofs
       WHERE shop_id = ${shopId} AND phone = ANY(${sql.param(customer.phones)}::text[])`);
    // Signed out of their account, everywhere, and its codes gone (ADR-570).
    await tx.execute(sql`
      DELETE FROM checkout.account_sessions
       WHERE shop_id = ${shopId}
         AND (customer_id = ${customer.id}
              OR phone = ANY(${sql.param(customer.phones)}::text[]))`);
    await tx.execute(sql`
      DELETE FROM checkout.number_codes
       WHERE shop_id = ${shopId} AND purpose = 'sign_in'
         AND phone = ANY(${sql.param(customer.phones)}::text[])`);
    // Checkouts they left (ADR-393): what they typed goes, and the checkout with it.
    await tx.execute(sql`
      UPDATE checkout.checkouts
         SET contact_name = NULL, contact_phone = NULL, contact_at = NULL, contact_lines = NULL,
             contact_subtotal = NULL, kept_until = NULL, reminder_token_hash = NULL
       WHERE shop_id = ${shopId} AND contact_phone = ANY(${sql.param(customer.phones)}::text[])`);
  },

  async export(tx, shopId, customer) {
    const { rows } = await tx.execute<{
      phone: string;
      proved_at: string | Date;
      expires_at: string | Date;
    }>(sql`
      SELECT phone, proved_at, expires_at FROM checkout.number_proofs
       WHERE shop_id = ${shopId} AND phone = ANY(${sql.param(customer.phones)}::text[])
       ORDER BY proved_at, id`);
    const { rows: left } = await tx.execute<{
      contact_phone: string;
      contact_name: string | null;
      contact_at: string | Date;
      contact_lines: { title: string; variantTitle: string; quantity: number }[] | null;
      reminded_at: string | Date | null;
    }>(sql`
      SELECT contact_phone, contact_name, contact_at, contact_lines, reminded_at
        FROM checkout.checkouts
       WHERE shop_id = ${shopId} AND contact_phone = ANY(${sql.param(customer.phones)}::text[])
       ORDER BY contact_at, id`);
    const { rows: sessions } = await tx.execute<{
      phone: string;
      created_at: string | Date;
      last_seen_at: string | Date;
      expires_at: string | Date;
    }>(sql`
      SELECT phone, created_at, last_seen_at, expires_at FROM checkout.account_sessions
       WHERE shop_id = ${shopId} AND revoked_at IS NULL AND expires_at > now()
         AND (customer_id = ${customer.id}
              OR phone = ANY(${sql.param(customer.phones)}::text[]))
       ORDER BY created_at, id`);
    return {
      numberProofs: rows.map((row) => ({
        number: row.phone,
        provedAt: toDate(row.proved_at),
        sparesCodesUntil: toDate(row.expires_at),
      })),
      // Checkouts they left with their number typed (ADR-393), and whether they were reminded.
      checkoutsLeft: left.map((row) => ({
        number: row.contact_phone,
        name: row.contact_name,
        at: toDate(row.contact_at),
        items: (row.contact_lines ?? []).map((line) => ({
          title: line.title,
          variantTitle: line.variantTitle,
          quantity: line.quantity,
        })),
        remindedAt: row.reminded_at ? toDate(row.reminded_at) : null,
      })),
      // Signed in to their account on the storefront (ADR-570), and until when unless used again.
      accountSessions: sessions.map((row) => ({
        number: row.phone,
        signedInAt: toDate(row.created_at),
        lastUsedAt: toDate(row.last_seen_at),
        endsAt: toDate(row.expires_at),
      })),
    };
  },
};

/** Adds checkout to merges, erasure and exports when the application starts. */
@Injectable()
export class CheckoutCustomerData implements OnModuleInit {
  constructor(private readonly registry: CustomerDataRegistry) {}

  onModuleInit(): void {
    this.registry.register(CHECKOUT_CUSTOMER_DATA);
  }
}
