import { failOne, isStaffRole, type MutationResult, type StaffRole } from '@hatti/api';
import type { Db } from '@hatti/db';
import { newId } from '@hatti/ids';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { normalizeEmail } from './identity.service.js';
import { memberships, shops, supportAgents, supportGrants, users } from './schema.js';

export const SUPPORT_LIMITS = {
  /** How long an owner lets Hatti's support look: 15 minutes to a day, an hour unless said. */
  leastMinutes: 15,
  mostMinutes: 24 * 60,
  defaultMinutes: 60,
  /** Characters in the note of what it is for. */
  note: 200,
  /** Grants a list shows at most. */
  grants: 50,
} as const;

/** A time a shop's owner let Hatti's support look (ADR-156). */
export interface SupportGrantRecord {
  id: string;
  /** What Hatti's support may do: look. */
  access: 'read';
  /** What it is for, as the owner noted it. */
  note: string | null;
  grantedBy: { userId: string; name: string };
  createdAt: Date;
  expiresAt: Date;
  /** When it stopped before its time, and who stopped it. */
  endedAt: Date | null;
  endedBy: { userId: string; name: string } | null;
  /** Neither ended nor past its time. */
  open: boolean;
}

/** A shop open to Hatti's support now, as an agent sees it. */
export interface SupportShopRecord {
  shopId: string;
  name: string;
  handle: string;
  grantId: string;
  note: string | null;
  expiresAt: Date;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type GrantRow = typeof supportGrants.$inferSelect;

/**
 * Hatti's support looking at a shop with its owner's consent (ADM-08, ADR-156): the owner lets it
 * look for a while, 15 minutes to a day, which ends any grant open; the owner or a manager ends
 * it at any time. Hatti's own agents are added and removed by Hatti. Each change reads the acting
 * member's role again, under a lock.
 */
export class SupportAccessService {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(options: { db: Db; now?: () => Date }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  /** The grant open now, if one is. */
  async openGrantOf(shopId: string): Promise<SupportGrantRecord | null> {
    const [grant] = await this.grantsOf(shopId, 1);
    return grant?.open ? grant : null;
  }

  /** The shop's grants, the newest first. */
  async grantsOf(shopId: string, first: number = 20): Promise<SupportGrantRecord[]> {
    const limit = Math.max(1, Math.min(first, SUPPORT_LIMITS.grants));
    const rows = await this.db
      .select()
      .from(supportGrants)
      .where(eq(supportGrants.shopId, shopId))
      .orderBy(desc(supportGrants.createdAt), desc(supportGrants.id))
      .limit(limit);
    return this.#records(rows);
  }

  /**
   * Lets Hatti's support look at the shop for `minutes`, reading alone: the owner alone, and any
   * grant open ends first. The grant, and the one it ended.
   */
  async grant(
    actor: { userId: string },
    shopId: string,
    input: { minutes?: number | null; note?: string | null },
  ): Promise<MutationResult<{ grant: SupportGrantRecord; ended: SupportGrantRecord | null }>> {
    type Result = MutationResult<{ grant: SupportGrantRecord; ended: SupportGrantRecord | null }>;
    const minutes = input.minutes ?? SUPPORT_LIMITS.defaultMinutes;
    if (
      !Number.isInteger(minutes) ||
      minutes < SUPPORT_LIMITS.leastMinutes ||
      minutes > SUPPORT_LIMITS.mostMinutes
    ) {
      return failOne(
        ['minutes'],
        'INVALID',
        `Support may look for ${SUPPORT_LIMITS.leastMinutes} minutes to a day: ` +
          `${SUPPORT_LIMITS.leastMinutes} to ${SUPPORT_LIMITS.mostMinutes} minutes`,
      );
    }
    const note = input.note?.trim() || null;
    if (note && note.length > SUPPORT_LIMITS.note) {
      return failOne(
        ['note'],
        'TOO_LONG',
        `Note must be ${SUPPORT_LIMITS.note} characters or fewer`,
      );
    }
    const now = this.now();
    const made = await this.db.transaction(async (tx): Promise<Result | GrantRow[]> => {
      if ((await roleIn(tx, actor.userId, shopId)) !== 'owner') {
        return failOne([], 'INVALID', "Only the shop's owner lets Hatti's support look");
      }
      const ended = await endOpen(tx, shopId, actor.userId, now);
      const [row] = await tx
        .insert(supportGrants)
        .values({
          id: newId(),
          shopId,
          grantedBy: actor.userId,
          note,
          createdAt: now,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        })
        .returning();
      return [row!, ...ended];
    });
    if (!Array.isArray(made)) return made;
    const [grant, ...ended] = await this.#records(made);
    // The grant still open that this one ends; one whose time ran out is only recorded so.
    return {
      ok: true,
      value: { grant: grant!, ended: ended.find((one) => one.endedBy !== null) ?? null },
    };
  }

  /** Ends the grant open now: the owner or a manager. The grant ended. */
  async end(
    actor: { userId: string },
    shopId: string,
  ): Promise<MutationResult<SupportGrantRecord>> {
    const now = this.now();
    const ended = await this.db.transaction(
      async (tx): Promise<MutationResult<SupportGrantRecord> | GrantRow[]> => {
        const role = await roleIn(tx, actor.userId, shopId);
        if (role !== 'owner' && role !== 'manager') {
          return failOne(
            [],
            'INVALID',
            "Only the shop's owner and managers end Hatti's support's access",
          );
        }
        const rows = await endOpen(tx, shopId, actor.userId, now);
        return rows.filter((row) => row.endedBy === actor.userId);
      },
    );
    if (!Array.isArray(ended)) return ended;
    const [grant] = await this.#records(ended);
    if (!grant) return failOne([], 'NOT_FOUND', "Hatti's support has no access to end");
    return { ok: true, value: grant };
  }

  /** Whether the account is one of Hatti's support agents now. */
  async isAgent(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: supportAgents.userId })
      .from(supportAgents)
      .where(and(eq(supportAgents.userId, userId), eq(supportAgents.status, 'active')));
    return row !== undefined;
  }

  /** The shops whose owners let Hatti's support look now, the soonest to close first. */
  async shopsOpenTo(userId: string): Promise<SupportShopRecord[]> {
    if (!(await this.isAgent(userId))) return [];
    const rows = await this.db
      .select({
        shopId: shops.id,
        name: shops.name,
        handle: shops.handle,
        grantId: supportGrants.id,
        note: supportGrants.note,
        expiresAt: supportGrants.expiresAt,
      })
      .from(supportGrants)
      .innerJoin(shops, and(eq(shops.id, supportGrants.shopId), eq(shops.status, 'active')))
      .where(and(isNull(supportGrants.endedAt), gt(supportGrants.expiresAt, this.now())))
      .orderBy(supportGrants.expiresAt);
    return rows;
  }

  /**
   * Makes the account signed up with `email` one of Hatti's support agents, or no longer one:
   * for Hatti alone, never through the Admin API. Whether the account was found.
   */
  async setAgent(email: string, active: boolean): Promise<boolean> {
    const normalized = normalizeEmail(email);
    if (!normalized) return false;
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized));
    if (!user) return false;
    const status = active ? 'active' : 'removed';
    await this.db
      .insert(supportAgents)
      .values({ userId: user.id, status })
      .onConflictDoUpdate({
        target: supportAgents.userId,
        set: { status, updatedAt: sql`now()` },
      });
    return true;
  }

  async #records(rows: readonly GrantRow[]): Promise<SupportGrantRecord[]> {
    const ids = [
      ...new Set(rows.flatMap((row) => [row.grantedBy, ...(row.endedBy ? [row.endedBy] : [])])),
    ];
    const names = new Map<string, string>();
    for (const id of ids) {
      const [user] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, id));
      if (user) names.set(id, user.name);
    }
    const now = this.now().getTime();
    return rows.map((row) => ({
      id: row.id,
      access: row.access,
      note: row.note,
      grantedBy: { userId: row.grantedBy, name: names.get(row.grantedBy) ?? '' },
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      endedAt: row.endedAt,
      endedBy: row.endedBy ? { userId: row.endedBy, name: names.get(row.endedBy) ?? '' } : null,
      open: row.endedAt === null && row.expiresAt.getTime() > now,
    }));
  }
}

/** The acting member's role in the shop, read under a lock; null for none. */
async function roleIn(tx: Tx, userId: string, shopId: string): Promise<StaffRole | null> {
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.shopId, shopId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('update');
  return row && isStaffRole(row.role) ? row.role : null;
}

/**
 * Stops the shop's grant not yet stopped: one still open ends now, by `userId`; one whose time
 * ran out is recorded as ended then. The grants stopped.
 */
async function endOpen(tx: Tx, shopId: string, userId: string, now: Date): Promise<GrantRow[]> {
  return tx
    .update(supportGrants)
    .set({
      endedAt: sql`least(${now.toISOString()}::timestamptz, ${supportGrants.expiresAt})`,
      endedBy: sql`CASE WHEN ${supportGrants.expiresAt} > ${now.toISOString()}::timestamptz
                        THEN ${userId}::uuid END`,
    })
    .where(and(eq(supportGrants.shopId, shopId), isNull(supportGrants.endedAt)))
    .returning();
}
