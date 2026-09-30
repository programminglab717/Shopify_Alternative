import { InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { parsePkMobile } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { OnlineStoreEvents, type PreferencesUpdatedPayload } from './events.js';
import type { PreferencesRecord } from './records.js';
import { preferences } from './schema.js';

export interface PreferencesInput {
  /** A Pakistani mobile number in any common format; blank to have none. Left as it is if absent. */
  whatsappNumber?: string | null;
}

/**
 * What a shop sets for its storefront as a whole (ADR-041): for now, the WhatsApp number its
 * "Order on WhatsApp" links and WhatsApp section go to. A shop that set nothing has none.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly db: Database) {}

  async get(tenant: TenantContext): Promise<PreferencesRecord> {
    return this.db.tenant(tenant.shopId, (tx) => this.preferencesOf(tx, tenant.shopId));
  }

  /** Changes those given; records `online_store_preferences.updated` if any changed. */
  async update(
    tenant: TenantContext,
    input: PreferencesInput,
  ): Promise<MutationResult<PreferencesRecord>> {
    const check = new InputChecker();
    let whatsapp: string | null | undefined;
    if (input.whatsappNumber !== undefined) {
      const text = input.whatsappNumber?.trim() ?? '';
      const mobile = text === '' ? null : parsePkMobile(text);
      if (text !== '' && !mobile) {
        check.addMessage(
          ['whatsappNumber'],
          'INVALID',
          'WhatsApp number must be a Pakistani mobile number, like 0300 1234567',
        );
      }
      whatsapp = mobile?.e164 ?? null;
    }
    if (!check.ok) return fail(check.errors);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await this.preferencesOf(tx, tenant.shopId, { lock: true });
      if (whatsapp === undefined || whatsapp === before.whatsappNumber) {
        return { ok: true, value: before };
      }
      await tx
        .insert(preferences)
        .values({ shopId: tenant.shopId, whatsapp })
        .onConflictDoUpdate({
          target: preferences.shopId,
          set: { whatsapp, updatedAt: sql`now()` },
        });
      await appendEvent<PreferencesUpdatedPayload>(tx, tenant.shopId, {
        type: OnlineStoreEvents.PreferencesUpdated,
        aggregateType: 'online_store_preferences',
        aggregateId: tenant.shopId,
        payload: { changed: ['whatsappNumber'] },
      });
      return { ok: true, value: { whatsappNumber: whatsapp } };
    });
  }

  /**
   * The shop's preferences, in the caller's transaction `tx`: for read models built outside the
   * module, such as the storefront's.
   */
  async preferencesOf(
    tx: Tx,
    shopId: string,
    options: { lock?: boolean } = {},
  ): Promise<PreferencesRecord> {
    const query = tx
      .select({ whatsapp: preferences.whatsapp })
      .from(preferences)
      .where(eq(preferences.shopId, shopId));
    const [row] = options.lock ? await query.for('update') : await query;
    return { whatsappNumber: row?.whatsapp ?? null };
  }
}
