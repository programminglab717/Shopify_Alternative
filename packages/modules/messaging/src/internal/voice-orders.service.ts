import type { TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Voice-note orders (MSG-11, ADR-871): whether the shop has its customers' WhatsApp voice notes
// heard and read into orders, answered with its checkout holding them. Off until it turns it on,
// as each voice note read spends one of its AI credits; a shop hears so many a day at most. The
// worker hears them; what came of each is kept here.

/** Whether the host hears voice notes at all: its speech-to-text server and its AI set up. */
export const VOICE_ORDERS_HEARD = Symbol('VOICE_ORDERS_HEARD');

export const VOICE_ORDER_DAY = {
  /** Voice notes a shop has heard a day, so that a flood of them cannot spend its month. */
  perDay: 200,
} as const;

/** What came of a voice note heard. */
export type VoiceOrderOutcome =
  'answered' | 'unmatched' | 'no_order' | 'not_heard' | 'too_long' | 'failed';

export interface VoiceOrderSetting {
  enabled: boolean;
  /** Whether Hatti hears voice notes here: without its speech server and AI, none is. */
  available: boolean;
  usedToday: number;
  limitPerDay: number;
}

/** Whether the shop has its voice notes heard. */
export async function voiceOrdersOnIn(tx: Tx, shopId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ enabled: boolean }>(sql`
    SELECT enabled FROM messaging.voice_order_settings WHERE shop_id = ${shopId}`);
  return rows[0]?.enabled ?? false;
}

/** Voice notes the shop heard since a day before `now`. */
export async function voiceOrdersSinceIn(tx: Tx, shopId: string, now: Date): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM messaging.voice_orders
     WHERE shop_id = ${shopId}
       AND created_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`);
  return rows[0]!.count;
}

/** What came of the voice note `messageId`, kept for the day's count and the AI's cost. */
export async function recordVoiceOrderIn(
  tx: Tx,
  shopId: string,
  record: {
    messageId: string;
    outcome: VoiceOrderOutcome;
    items?: number;
    matched?: number;
    inputTokens?: number;
    outputTokens?: number;
    at: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO messaging.voice_orders
      (shop_id, message_id, outcome, items, matched, input_tokens, output_tokens, created_at)
    VALUES (${shopId}, ${record.messageId}, ${record.outcome}, ${record.items ?? 0},
            ${record.matched ?? 0}, ${record.inputTokens ?? 0}, ${record.outputTokens ?? 0},
            ${record.at.toISOString()})`);
}

@Injectable()
export class VoiceOrderService {
  constructor(
    private readonly db: Database,
    @Optional() @Inject(VOICE_ORDERS_HEARD) private readonly heard: boolean | null = null,
  ) {}

  /** Whether the shop has its voice notes heard, and how many it heard in the last day. */
  async setting(tenant: TenantContext, now: Date = new Date()): Promise<VoiceOrderSetting> {
    return this.db.tenant(tenant.shopId, async (tx) => ({
      enabled: await voiceOrdersOnIn(tx, tenant.shopId),
      available: this.heard ?? false,
      usedToday: await voiceOrdersSinceIn(tx, tenant.shopId, now),
      limitPerDay: VOICE_ORDER_DAY.perDay,
    }));
  }

  /** Turns hearing the shop's voice notes on or off. */
  async set(tenant: TenantContext, enabled: boolean): Promise<VoiceOrderSetting> {
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO messaging.voice_order_settings (shop_id, enabled, updated_at)
        VALUES (${tenant.shopId}, ${enabled}, now())
        ON CONFLICT (shop_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`),
    );
    return this.setting(tenant);
  }
}
