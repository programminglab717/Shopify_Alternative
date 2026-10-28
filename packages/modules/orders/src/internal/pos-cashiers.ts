import { failOne, InputChecker, fail, type MutationResult, type TenantContext } from '@hatti/api';
import { checkPassword, passwordVerifier, SecretBox } from '@hatti/crypto';
import { Database, toDateOrNull, type Tx } from '@hatti/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// Cashiers at a shared till (POS-07, ADR-874): each member of staff sets a PIN of their own, kept
// as a scrypt verifier; at the till they sign in with it, and the till is given a sealed token,
// bound to the shop and the register's session, that its sales carry, offline ones too, so each
// sale names who rang it up. Five wrong PINs lock a session's sign-ins for five minutes.

export const POS_PIN_LIMITS = {
  /** Wrong PINs a session allows before it locks. */
  tries: 5,
  /** How long it stays locked. */
  lockMs: 5 * 60_000,
  /** How long a sign-in lasts: a shift. */
  signInMs: 12 * 3_600_000,
} as const;

/** A cashier signed in at a till: who, and the token their sales carry. */
export interface PosCashierSignIn {
  userId: string;
  name: string;
  token: string;
  expiresAt: Date;
}

/** Why a PIN is too easy to guess: one digit throughout, or a run up or down. */
function weak(pin: string): boolean {
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((digit, index) => digit - digits[index]!);
  return (
    steps.every((step) => step === 0) ||
    steps.every((step) => step === 1) ||
    steps.every((step) => step === -1)
  );
}

const associated = (shopId: string) => `pos-cashier:${shopId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class PosCashierService {
  constructor(
    private readonly db: Database,
    /** Seals cashiers' tokens; without it, as in some tests, none is given. */
    @Optional() @Inject(SecretBox) private readonly box?: SecretBox | null,
  ) {}

  /** Whether the signed-in member of staff has a till PIN, and the name it shows. */
  async mine(tenant: TenantContext): Promise<{ set: boolean; name: string | null }> {
    if (tenant.actor.kind !== 'staff') return { set: false, name: null };
    const userId = tenant.actor.userId;
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<{ name: string }>(sql`
        SELECT name FROM orders.pos_staff_pins
         WHERE shop_id = ${tenant.shopId} AND user_id = ${userId}`),
    );
    return { set: rows.length > 0, name: rows[0]?.name ?? null };
  }

  /** Sets the signed-in member of staff's till PIN, and the name the till shows them by. */
  async setPin(
    tenant: TenantContext,
    input: { pin: string; name: string },
  ): Promise<MutationResult<{ name: string }>> {
    if (tenant.actor.kind !== 'staff') {
      return failOne(['pin'], 'INVALID', 'A till PIN is a member of staff’s own');
    }
    const userId = tenant.actor.userId;
    const check = new InputChecker();
    const name = check.text(['name'], input.name, { required: true, max: 80 });
    const pin = input.pin.trim();
    if (!/^[0-9]{4,6}$/.test(pin)) check.add(['pin'], 'INVALID', 'must be 4 to 6 digits');
    else if (weak(pin)) {
      check.addMessage(['pin'], 'INVALID', 'Choose a PIN harder to guess than 1111 or 1234');
    }
    if (!check.ok || !name) return fail(check.errors);
    const verifier = await passwordVerifier(pin);
    return this.db.tenant(tenant.shopId, async (tx) => {
      // One at a time, so that two members can't take one PIN at once.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pos-pins:${tenant.shopId}`}))`);
      const { rows } = await tx.execute<{ pin_verifier: string }>(sql`
        SELECT pin_verifier FROM orders.pos_staff_pins
         WHERE shop_id = ${tenant.shopId} AND user_id <> ${userId}`);
      for (const row of rows) {
        if (await checkPassword(pin, row.pin_verifier)) {
          return failOne(['pin'], 'TAKEN', 'Another member of staff has this PIN: choose another');
        }
      }
      await tx.execute(sql`
        INSERT INTO orders.pos_staff_pins (shop_id, user_id, name, pin_verifier, updated_at)
        VALUES (${tenant.shopId}, ${userId}, ${name}, ${verifier}, now())
            ON CONFLICT (shop_id, user_id) DO UPDATE
           SET name = EXCLUDED.name, pin_verifier = EXCLUDED.pin_verifier, updated_at = now()`);
      return { ok: true, value: { name } };
    });
  }

  /** Takes the signed-in member of staff's till PIN away. */
  async removePin(tenant: TenantContext): Promise<void> {
    if (tenant.actor.kind !== 'staff') return;
    const userId = tenant.actor.userId;
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        DELETE FROM orders.pos_staff_pins
         WHERE shop_id = ${tenant.shopId} AND user_id = ${userId}`),
    );
  }

  /**
   * A cashier signing in at the open session `sessionId` with their PIN: the token its sales
   * carry, or why not.
   */
  async signIn(
    tenant: TenantContext,
    sessionId: string,
    pin: string,
    now: Date = new Date(),
  ): Promise<MutationResult<PosCashierSignIn>> {
    const box = this.box;
    if (!box) return failOne(['pin'], 'UNAVAILABLE', 'Cashiers can’t sign in here');
    if (!UUID.test(sessionId)) return failOne(['sessionId'], 'NOT_FOUND', 'No such session');
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: sessions } = await tx.execute<{ closed_at: string | Date | null }>(sql`
        SELECT closed_at FROM orders.pos_sessions
         WHERE shop_id = ${tenant.shopId} AND id = ${sessionId} FOR UPDATE`);
      if (!sessions[0]) return failOne(['sessionId'], 'NOT_FOUND', 'No such session');
      if (sessions[0].closed_at) {
        return failOne(['sessionId'], 'INVALID', 'The register’s session is closed');
      }
      const tries = await triesIn(tx, tenant.shopId, sessionId);
      if (tries.lockedUntil && tries.lockedUntil > now) {
        return failOne(['pin'], 'TOO_MANY', 'Too many wrong PINs: try again in a few minutes');
      }
      const { rows } = await tx.execute<{ user_id: string; name: string; pin_verifier: string }>(
        sql`SELECT user_id, name, pin_verifier FROM orders.pos_staff_pins
             WHERE shop_id = ${tenant.shopId}`,
      );
      let found: { user_id: string; name: string } | null = null;
      for (const row of rows) {
        if (/^[0-9]{4,6}$/.test(pin) && (await checkPassword(pin, row.pin_verifier))) {
          found = row;
          break;
        }
      }
      if (!found) {
        const failures = tries.failures + 1;
        const locked = failures >= POS_PIN_LIMITS.tries;
        await tx.execute(sql`
          INSERT INTO orders.pos_pin_tries (shop_id, session_id, failures, locked_until)
          VALUES (${tenant.shopId}, ${sessionId}, ${locked ? 0 : failures},
                  ${locked ? new Date(now.getTime() + POS_PIN_LIMITS.lockMs).toISOString() : null})
              ON CONFLICT (shop_id, session_id) DO UPDATE
             SET failures = EXCLUDED.failures, locked_until = EXCLUDED.locked_until`);
        return failOne(['pin'], 'INVALID', 'No member of staff has this PIN');
      }
      await tx.execute(sql`
        DELETE FROM orders.pos_pin_tries
         WHERE shop_id = ${tenant.shopId} AND session_id = ${sessionId}`);
      const expiresAt = new Date(now.getTime() + POS_PIN_LIMITS.signInMs);
      const token = box.encrypt(
        JSON.stringify({ u: found.user_id, n: found.name, s: sessionId, e: expiresAt.getTime() }),
        associated(tenant.shopId),
      );
      return { ok: true, value: { userId: found.user_id, name: found.name, token, expiresAt } };
    });
  }

  /**
   * The cashier a sale's token names, for a sale at `sessionId` sold at `soldAt`; null where it
   * is no token of this shop's, of another session, or of a sign-in that had ended by then.
   */
  cashierOf(
    shopId: string,
    token: string,
    sessionId: string,
    soldAt: Date,
  ): { userId: string; name: string } | null {
    if (!this.box) return null;
    try {
      const sealed = JSON.parse(this.box.decrypt(token, associated(shopId)).toString('utf8')) as {
        u?: unknown;
        n?: unknown;
        s?: unknown;
        e?: unknown;
      };
      if (
        typeof sealed.u !== 'string' ||
        typeof sealed.n !== 'string' ||
        sealed.s !== sessionId ||
        typeof sealed.e !== 'number' ||
        soldAt.getTime() > sealed.e
      ) {
        return null;
      }
      return { userId: sealed.u, name: sealed.n };
    } catch {
      return null;
    }
  }
}

async function triesIn(
  tx: Tx,
  shopId: string,
  sessionId: string,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const { rows } = await tx.execute<{ failures: number; locked_until: string | Date | null }>(sql`
    SELECT failures, locked_until FROM orders.pos_pin_tries
     WHERE shop_id = ${shopId} AND session_id = ${sessionId}`);
  return {
    failures: rows[0]?.failures ?? 0,
    lockedUntil: toDateOrNull(rows[0]?.locked_until ?? null),
  };
}
