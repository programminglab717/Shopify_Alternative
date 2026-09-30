import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { SecretBox, passwordVerifier } from '@hatti/crypto';
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
  /** Closes the storefront behind its password, or opens it. Left as it is if absent. */
  passwordEnabled?: boolean | null;
  /** The storefront's password, 4 to 100 characters: changed, never taken away. */
  password?: string | null;
  /** What the password page tells shoppers, up to 1,000 characters; blank for nothing. */
  passwordMessage?: string | null;
}

/** The shop's preferences as its staff see them, the storefront's password among them. */
export interface PreferencesView extends PreferencesRecord {
  /** Null until one is set. */
  password: string | null;
}

export const PASSWORD_LENGTH = { min: 4, max: 100 } as const;
export const PASSWORD_MESSAGE_MAX = 1_000;

type PreferencesRow = typeof preferences.$inferSelect;

/**
 * What a shop sets for its storefront as a whole (ADR-041): the WhatsApp number its "Order on
 * WhatsApp" links and WhatsApp section go to, and the password it is closed behind until it
 * opens (ADR-054). A shop that set nothing has no number and an open storefront.
 */
@Injectable()
export class PreferencesService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  async get(tenant: TenantContext): Promise<PreferencesView> {
    return this.db.tenant(tenant.shopId, async (tx) =>
      this.#view(tenant.shopId, await rowOf(tx, tenant.shopId)),
    );
  }

  /** Changes those given; records `online_store_preferences.updated` if any changed. */
  async update(
    tenant: TenantContext,
    input: PreferencesInput,
  ): Promise<MutationResult<PreferencesView>> {
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
    let password: string | undefined;
    if (input.password !== undefined) {
      const text = input.password?.trim() ?? '';
      if (
        text.length < PASSWORD_LENGTH.min ||
        text.length > PASSWORD_LENGTH.max ||
        /\p{Cc}/u.test(text)
      ) {
        check.addMessage(
          ['password'],
          'INVALID',
          `Password must be ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters`,
        );
      } else password = text;
    }
    let message: string | undefined;
    if (input.passwordMessage !== undefined) {
      message = (input.passwordMessage ?? '').replace(/\r\n?/g, '\n').trim();
      if (message.length > PASSWORD_MESSAGE_MAX) {
        check.addMessage(
          ['passwordMessage'],
          'TOO_LONG',
          'Message is too long (maximum is 1,000 characters)',
        );
      } else if (/[^\P{Cc}\n\t]/u.test(message)) {
        check.addMessage(['passwordMessage'], 'INVALID', 'Message has characters it cannot show');
      }
    }
    if (!check.ok) return fail(check.errors);
    // Some 50 ms of scrypt, before the transaction rather than inside it.
    const verifier = password === undefined ? undefined : await passwordVerifier(password);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await rowOf(tx, tenant.shopId, { lock: true });
      const was = this.#view(tenant.shopId, before);
      const next = {
        whatsapp: whatsapp === undefined ? was.whatsappNumber : whatsapp,
        passwordEnabled: input.passwordEnabled ?? was.passwordEnabled,
        // The same password again keeps its verifier, and the passes shoppers hold.
        password: password ?? was.password,
        passwordMessage: message ?? was.passwordMessage,
      };
      if (next.passwordEnabled && next.password === null) {
        return failOne(
          ['password'],
          'BLANK',
          'Set a password before closing the storefront behind it',
        );
      }
      const changed = [
        ...(next.whatsapp !== was.whatsappNumber ? ['whatsappNumber'] : []),
        ...(next.passwordEnabled !== was.passwordEnabled ? ['passwordEnabled'] : []),
        ...(next.password !== was.password ? ['password'] : []),
        ...(next.passwordMessage !== was.passwordMessage ? ['passwordMessage'] : []),
      ];
      if (changed.length === 0) return { ok: true, value: was };
      const newPassword = changed.includes('password') && next.password !== null;
      const values = {
        whatsapp: next.whatsapp,
        passwordEnabled: next.passwordEnabled,
        passwordSealed: newPassword
          ? this.box.encrypt(next.password!, sealedFor(tenant.shopId))
          : (before?.passwordSealed ?? null),
        passwordVerifier: newPassword ? verifier! : (before?.passwordVerifier ?? null),
        passwordMessage: next.passwordMessage,
      };
      const [row] = await tx
        .insert(preferences)
        .values({ shopId: tenant.shopId, ...values })
        .onConflictDoUpdate({
          target: preferences.shopId,
          set: { ...values, updatedAt: sql`now()` },
        })
        .returning();
      await appendEvent<PreferencesUpdatedPayload>(tx, tenant.shopId, {
        type: OnlineStoreEvents.PreferencesUpdated,
        aggregateType: 'online_store_preferences',
        aggregateId: tenant.shopId,
        payload: { changed },
      });
      return { ok: true, value: this.#view(tenant.shopId, row) };
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
    return toRecord(await rowOf(tx, shopId, options));
  }

  #view(shopId: string, row: PreferencesRow | undefined): PreferencesView {
    const password = row?.passwordSealed
      ? this.box.decrypt(row.passwordSealed, sealedFor(shopId)).toString('utf8')
      : null;
    return { ...toRecord(row), password };
  }
}

/**
 * The shop's preferences, in the caller's transaction `tx`, as {@link PreferencesService} gives
 * read models them, for those without the service: its password's verifier, never the password.
 */
export async function shopPreferencesOf(tx: Tx, shopId: string): Promise<PreferencesRecord> {
  return toRecord(await rowOf(tx, shopId));
}

async function rowOf(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<PreferencesRow | undefined> {
  const query = tx.select().from(preferences).where(eq(preferences.shopId, shopId));
  const [row] = options.lock ? await query.for('update') : await query;
  return row;
}

function toRecord(row: PreferencesRow | undefined): PreferencesRecord {
  return {
    whatsappNumber: row?.whatsapp ?? null,
    passwordEnabled: row?.passwordEnabled ?? false,
    passwordVerifier: row?.passwordVerifier ?? null,
    passwordMessage: row?.passwordMessage ?? '',
  };
}

/** What a shop's sealed password is bound to: it opens for that shop alone. */
function sealedFor(shopId: string): string {
  return `storefront-password:${shopId}`;
}
