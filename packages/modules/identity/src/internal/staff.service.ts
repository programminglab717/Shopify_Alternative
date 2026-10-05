import {
  MFA_REQUIRED_ROLES,
  UserErrorsRollback,
  failOne,
  isStaffRole,
  planLimitMessage,
  rollbackResult,
  type MutationResult,
  type PlanLimit,
  type StaffRole,
} from '@hatti/api';
import { secretToken, sha256 } from '@hatti/crypto';
import type { Db, Tx as ShopTx } from '@hatti/db';
import { newId, toPublicId } from '@hatti/ids';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { invitationEmail, type AccountEmailLanguage } from './account-emails.js';
import { suppressed } from './email-feedback.js';
import { AuthError } from './errors.js';
import {
  ipOf,
  normalizeEmail,
  userAgentOf,
  type AccountEmails,
  type ClientInfo,
  type ShopAccess,
} from './identity.service.js';
import {
  authEvents,
  invitations,
  memberships,
  passkeys,
  shops,
  totpCredentials,
  users,
} from './schema.js';

const INVITATION_TOKEN_PREFIX = 'hsi_';
const INVITATION_TOKEN_PATTERN = /^hsi_[A-Za-z0-9_-]{43}$/;

export const STAFF_LIMITS = {
  /** How long an invitation's link works. */
  invitationMs: 7 * 24 * 3_600_000,
  /** Invitations a shop has waiting at once. */
  pendingInvitations: 50,
  /** Characters in the note of whom an invitation is for. */
  note: 100,
  /** Invitations a shop has Hatti email in a day (ADR-167). */
  emailsPerDay: 20,
} as const;

/**
 * The roles a staff member in `role` invites, changes and removes (ADR-101): the owner every role
 * but its own, managers those below them, and no one else any. Nobody is made the owner so: the
 * owner hands the shop over instead (ADR-104).
 */
export function managedRoles(role: StaffRole): readonly StaffRole[] {
  switch (role) {
    case 'owner':
      return ['manager', 'confirmation_agent', 'packer', 'marketer', 'accountant'];
    case 'manager':
      return ['confirmation_agent', 'packer', 'marketer', 'accountant'];
    default:
      return [];
  }
}

/** Someone who works in a shop, as its owner and managers see them. */
export interface StaffMemberRecord {
  userId: string;
  name: string;
  /** Null for one who opened their account with a phone alone (ADR-159). */
  email: string | null;
  role: StaffRole;
  joinedAt: Date;
}

/**
 * A member of staff as Hatti tells them of their own work (ADR-191): by the number their account
 * signs in with.
 */
export interface StaffPhoneRecord {
  userId: string;
  name: string;
  /** In E.164, where they proved it with a code and their account is not disabled; else null. */
  phone: string | null;
  /** What Hatti's words to them are in (ADR-194). */
  language: 'en' | 'ur';
}

/**
 * The shop's staff with the numbers Hatti tells them of their own work at (ADR-191): each one's
 * account's number, where they proved it with a code; none for an account disabled. Those who
 * left are not among them. Read in the caller's transaction, for its own shop, through
 * identity.staff_phones (ADR-193), as the worker reads them: never identity's tables.
 */
export async function staffPhonesIn(tx: ShopTx, shopId: string): Promise<StaffPhoneRecord[]> {
  const { rows } = await tx.execute<{
    user_id: string;
    name: string;
    role: string;
    phone: string | null;
    language: 'en' | 'ur';
  }>(sql`SELECT user_id, name, role, phone, language FROM identity.staff_phones(${shopId})`);
  return rows.flatMap((row) =>
    isStaffRole(row.role)
      ? [{ userId: row.user_id, name: row.name, phone: row.phone, language: row.language }]
      : [],
  );
}

/** A shop's owner as Hatti tells them of its bills (ADR-195): at the email their account proved. */
export interface OwnerEmailRecord {
  userId: string;
  name: string;
  email: string;
  /** What Hatti's words to them are in (ADR-194). */
  language: 'en' | 'ur';
}

/**
 * The shop's owner, at the email their account proved and that still takes Hatti's mail, with
 * their language (ADR-195); null while they have none such, or are disabled. Read in the caller's
 * transaction, for its own shop, through identity.staff_phones and identity.staff_email, as the
 * worker reads staff (ADR-183, ADR-193): never identity's tables.
 */
export async function ownerEmailIn(tx: ShopTx, shopId: string): Promise<OwnerEmailRecord | null> {
  const { rows } = await tx.execute<{
    user_id: string;
    name: string;
    email: string;
    language: 'en' | 'ur';
  }>(sql`
    SELECT member.user_id, account.name, account.email, account.language
      FROM identity.staff_phones(${shopId}) member
     CROSS JOIN LATERAL identity.staff_email(member.user_id, ${shopId}) account
     WHERE member.role = 'owner'`);
  const [row] = rows;
  return row
    ? { userId: row.user_id, name: row.name, email: row.email, language: row.language }
    : null;
}

/** An invitation still waiting to be accepted. */
export interface StaffInvitationRecord {
  id: string;
  role: StaffRole;
  /** Whom it is for, as the inviter noted it. */
  note: string | null;
  /** Where Hatti emailed its link (ADR-167); null when the inviter shares it alone. */
  email: string | null;
  invitedBy: { userId: string; name: string };
  createdAt: Date;
  expiresAt: Date;
}

/** What an invitation's link says before it is accepted. */
export interface InvitationPreview {
  shop: { name: string };
  role: StaffRole;
  invitedBy: string;
  expiresAt: Date;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Pick<Db, 'insert' | 'select'>;

/**
 * Who works in each shop (ADR-101): owners and managers invite people with a role by a link,
 * which the person accepts once signed in, and change staff's roles or remove them; the owner
 * hands the shop to a manager (ADR-104). Each change reads the acting member's role again, under
 * a lock, and goes on their account's record.
 */
export class StaffService {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly emails: AccountEmails | null;

  constructor(options: { db: Db; now?: () => Date; emails?: AccountEmails | null }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.emails = options.emails ?? null;
  }

  /** The shop's staff: its owner first, then everyone else as they joined. */
  async staffOf(shopId: string): Promise<StaffMemberRecord[]> {
    const rows = await this.db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.shopId, shopId), eq(memberships.status, 'active')))
      .orderBy(sql`${memberships.role} = 'owner' DESC`, asc(memberships.createdAt), asc(users.id));
    return rows.flatMap((row) => (isStaffRole(row.role) ? [{ ...row, role: row.role }] : []));
  }

  /**
   * Accounts' names by their IDs, whether or not they still work in a shop, for what a shop's own
   * records say they did, such as the comments on its orders (ADR-128). Accounts not found are
   * left out.
   */
  async namesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** Invitations neither accepted, taken back nor expired, the newest first. */
  async invitationsOf(shopId: string): Promise<StaffInvitationRecord[]> {
    const rows = await this.db
      .select({ invitation: invitations, inviter: users.name })
      .from(invitations)
      .innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.shopId, shopId), pending(this.now())))
      .orderBy(desc(invitations.createdAt), desc(invitations.id));
    return rows.flatMap((row) => {
      const invitation = toInvitation(row.invitation, row.inviter);
      return invitation ? [invitation] : [];
    });
  }

  /**
   * Invites someone to the shop in `role`, by the link `token` makes, shown this once and good
   * for 7 days. The acting member must manage the role. With `limit`, the shop's plan's limit on
   * staff (ADR-154), its members and the invitations waiting stay within it. With `email`, Hatti
   * emails the link there too, in `language`, 20 a day for a shop at most (ADR-167): `emailed`
   * says whether it went.
   */
  async invite(
    actor: { userId: string },
    shopId: string,
    input: {
      role: string;
      note?: string | null;
      email?: string | null;
      language?: AccountEmailLanguage | null;
    },
    client: ClientInfo = {},
    limit: PlanLimit | null = null,
  ): Promise<
    MutationResult<{ invitation: StaffInvitationRecord; token: string; emailed: boolean }>
  > {
    const note = input.note?.trim() || null;
    if (note && note.length > STAFF_LIMITS.note) {
      return failOne(['note'], 'TOO_LONG', `Note must be ${STAFF_LIMITS.note} characters or fewer`);
    }
    let email: string | null = null;
    if (input.email?.trim()) {
      email = normalizeEmail(input.email);
      if (!email) return failOne(['email'], 'INVALID', 'Enter a valid email address');
    }
    const created = await this.db.transaction(async (tx) => {
      const made = await this.createInvitationIn(tx, actor, shopId, input.role, note, email, limit);
      if (made.ok) await this.recordEvent(tx, actor.userId, 'staff_invited', client);
      return made;
    });
    if (!created.ok) return created;
    const { shop, ...value } = created.value;
    const emailed = await this.emailInvitation(actor, value, shop, input.language);
    return { ok: true, value: { ...value, emailed } };
  }

  /**
   * Emails an invitation still waiting to its address again (ADR-196): an invitation of its role,
   * note and address takes its place, by a new link good for 7 days, and the one before is taken
   * back, its link opening nothing. Within the limits a new one keeps, 20 emailed a day for a shop
   * among them, and in `language`, or the acting member's own (ADR-194). The acting member must
   * manage its role.
   */
  async resendInvitation(
    actor: { userId: string },
    shopId: string,
    invitationId: string,
    input: { language?: AccountEmailLanguage | null } = {},
    client: ClientInfo = {},
    limit: PlanLimit | null = null,
  ): Promise<
    MutationResult<{
      invitation: StaffInvitationRecord;
      token: string;
      emailed: boolean;
      /** The invitation it took the place of. */
      replaced: string;
    }>
  > {
    type Made = MutationResult<{ invitation: StaffInvitationRecord; token: string; shop: string }>;
    const field = ['id'];
    const resent = await rollbackResult(() =>
      this.db.transaction(async (tx): Promise<Made> => {
        const [row] = await tx
          .select()
          .from(invitations)
          .where(and(eq(invitations.id, invitationId), eq(invitations.shopId, shopId)))
          .for('update');
        if (!row || row.revokedAt) return failOne(field, 'NOT_FOUND', 'Invitation not found');
        if (row.acceptedAt) return failOne(field, 'INVALID', 'It was accepted already');
        if (row.expiresAt <= this.now()) {
          return failOne(field, 'INVALID', 'It has expired: invite them again');
        }
        if (!row.email) {
          return failOne(field, 'INVALID', 'It has no email address: share its link instead');
        }
        const denied = mayManage(await actingRole(tx, actor.userId, shopId), row.role, field);
        if (denied) return denied;
        // Taken back first, so that it counts against no limit its replacement is held to.
        await tx
          .update(invitations)
          .set({ revokedAt: this.now() })
          .where(eq(invitations.id, row.id));
        const made = await this.createInvitationIn(
          tx,
          actor,
          shopId,
          row.role,
          row.note,
          row.email,
          limit,
          field,
        );
        // Refused, the one before stands as it was.
        if (!made.ok) throw new UserErrorsRollback(made.errors);
        await this.recordEvent(tx, actor.userId, 'staff_invitation_resent', client);
        return made;
      }),
    );
    if (!resent.ok) return resent;
    const { shop, ...value } = resent.value;
    const emailed = await this.emailInvitation(actor, value, shop, input.language);
    return { ok: true, value: { ...value, emailed, replaced: invitationId } };
  }

  /**
   * Emails the invitation's link to its address, if it has one Hatti may send to (ADR-167,
   * ADR-170), in `language` or the acting member's own (ADR-194); whether it went. After the
   * invitation commits: one that could not go leaves it standing.
   */
  private async emailInvitation(
    actor: { userId: string },
    value: { invitation: StaffInvitationRecord; token: string },
    shop: string,
    language: AccountEmailLanguage | null | undefined,
  ): Promise<boolean> {
    const { email } = value.invitation;
    // Never to an address that bounced or complained (ADR-170).
    return (
      email !== null &&
      this.emails !== null &&
      !(await suppressed(this.db, email)) &&
      (await this.emails.sender
        .send(
          invitationEmail({
            to: email,
            inviter: value.invitation.invitedBy.name,
            shop,
            role: value.invitation.role,
            link: `${this.emails.adminUrl.replace(/\/+$/, '')}/invitation#token=${value.token}`,
            // The invitee's own is not known yet: the inviter's (ADR-194).
            language: language ?? (await this.languageOf(actor.userId)),
          }),
        )
        .catch(() => false))
    );
  }

  /** The language of account `userId`'s own (ADR-194); English for one not found. */
  private async languageOf(userId: string): Promise<AccountEmailLanguage> {
    const [user] = await this.db
      .select({ language: users.language })
      .from(users)
      .where(eq(users.id, userId));
    return user?.language ?? 'en';
  }

  /**
   * Makes an invitation in the caller's transaction, within the shop's limits: those waiting at
   * once, its plan's staff with `limit`, and 20 emailed a day. Errors name `field`, where given,
   * in place of the input each is about.
   */
  private async createInvitationIn(
    tx: Tx,
    actor: { userId: string },
    shopId: string,
    role: string,
    note: string | null,
    email: string | null,
    limit: PlanLimit | null,
    field: string[] | null = null,
  ): Promise<MutationResult<{ invitation: StaffInvitationRecord; token: string; shop: string }>> {
    const acting = await actingRole(tx, actor.userId, shopId);
    const denied = mayManage(acting, role, field ?? ['role']);
    if (denied) return denied;
    const now = this.now();
    const [waiting] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(invitations)
      .where(and(eq(invitations.shopId, shopId), pending(now)));
    if ((waiting?.count ?? 0) >= STAFF_LIMITS.pendingInvitations) {
      return failOne(
        field ?? ['role'],
        'TOO_MANY',
        `At most ${STAFF_LIMITS.pendingInvitations} invitations wait at once: take some back`,
      );
    }
    if (limit) {
      const [members] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(memberships)
        .where(and(eq(memberships.shopId, shopId), eq(memberships.status, 'active')));
      if ((members?.count ?? 0) + (waiting?.count ?? 0) >= limit.limit) {
        return failOne(
          field ?? ['role'],
          'TOO_MANY',
          planLimitMessage(limit, 'member of staff', 'members of staff'),
        );
      }
    }
    if (email) {
      const [emailed] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(invitations)
        .where(
          and(
            eq(invitations.shopId, shopId),
            isNotNull(invitations.email),
            gt(invitations.createdAt, new Date(now.getTime() - 24 * 3_600_000)),
          ),
        );
      if ((emailed?.count ?? 0) >= STAFF_LIMITS.emailsPerDay) {
        return failOne(
          field ?? ['email'],
          'TOO_MANY',
          `At most ${STAFF_LIMITS.emailsPerDay} invitations by email a day: share the link instead`,
        );
      }
    }
    const [shop] = await tx.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
    const token = secretToken(INVITATION_TOKEN_PREFIX);
    const [row] = await tx
      .insert(invitations)
      .values({
        id: newId(),
        shopId,
        role: role,
        note,
        email,
        tokenHash: sha256(token),
        invitedBy: actor.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + STAFF_LIMITS.invitationMs),
      })
      .returning();
    const invitation = toInvitation(row!, await nameOf(tx, actor.userId));
    return { ok: true, value: { invitation: invitation!, token, shop: shop?.name ?? '' } };
  }

  /** Takes back an invitation not yet accepted, of a role the acting member manages. */
  async revokeInvitation(
    actor: { userId: string },
    shopId: string,
    invitationId: string,
    client: ClientInfo = {},
  ): Promise<MutationResult<StaffInvitationRecord>> {
    return this.db.transaction(async (tx): Promise<MutationResult<StaffInvitationRecord>> => {
      const acting = await actingRole(tx, actor.userId, shopId);
      const [row] = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.id, invitationId), eq(invitations.shopId, shopId)))
        .for('update');
      if (!row || row.revokedAt) return failOne(['id'], 'NOT_FOUND', 'Invitation not found');
      if (row.acceptedAt) {
        return failOne(['id'], 'INVALID', 'It was accepted already: remove the staff member');
      }
      const denied = mayManage(acting, row.role, ['id']);
      if (denied) return denied;
      await tx.update(invitations).set({ revokedAt: this.now() }).where(eq(invitations.id, row.id));
      await this.recordEvent(tx, actor.userId, 'staff_invitation_revoked', client);
      const invitation = toInvitation(row, await nameOf(tx, row.invitedBy));
      return { ok: true, value: invitation! };
    });
  }

  /** Gives a staff member another role; both must be ones the acting member manages. */
  async changeRole(
    actor: { userId: string },
    shopId: string,
    userId: string,
    role: string,
    client: ClientInfo = {},
  ): Promise<MutationResult<{ member: StaffMemberRecord; previousRole: StaffRole }>> {
    type Result = MutationResult<{ member: StaffMemberRecord; previousRole: StaffRole }>;
    return this.db.transaction(async (tx): Promise<Result> => {
      const acting = await actingRole(tx, actor.userId, shopId);
      const target = await memberOf(tx, userId, shopId);
      if (!target) return failOne(['id'], 'NOT_FOUND', 'Staff member not found');
      if (userId === actor.userId) {
        return failOne(['id'], 'INVALID', 'Your own role is changed by the owner');
      }
      const denied = mayManage(acting, target.role, ['id']) ?? mayManage(acting, role, ['role']);
      if (denied) return denied;
      if (role !== target.role) {
        await tx
          .update(memberships)
          .set({ role, updatedAt: this.now() })
          .where(and(eq(memberships.userId, userId), eq(memberships.shopId, shopId)));
        await this.recordEvent(tx, actor.userId, 'staff_role_changed', client);
      }
      const [member] = (await this.staffIn(tx, shopId)).filter((each) => each.userId === userId);
      return { ok: true, value: { member: member!, previousRole: target.role } };
    });
  }

  /**
   * Hands the shop to one of its managers, for its owner, who stays on as a manager (ADR-104).
   * The new owner needs a second factor, as owners do. The shop has one owner throughout: the old
   * one steps down before the new one steps up, both rows locked.
   */
  async transferOwnership(
    actor: { userId: string },
    shopId: string,
    userId: string,
    client: ClientInfo = {},
  ): Promise<MutationResult<{ owner: StaffMemberRecord; previousOwner: StaffMemberRecord }>> {
    type Result = MutationResult<{ owner: StaffMemberRecord; previousOwner: StaffMemberRecord }>;
    const field = ['staffMemberId'];
    return this.db.transaction(async (tx): Promise<Result> => {
      if ((await actingRole(tx, actor.userId, shopId)) !== 'owner') {
        return failOne(field, 'INVALID', 'Only the owner hands the shop over');
      }
      if (userId === actor.userId) return failOne(field, 'INVALID', 'You own the shop already');
      const target = await memberOf(tx, userId, shopId);
      if (!target) return failOne(field, 'NOT_FOUND', 'Staff member not found');
      if (target.role !== 'manager') {
        return failOne(field, 'INVALID', 'The shop goes to a manager: make them one first');
      }
      if (!(await hasSecondFactor(tx, userId))) {
        return failOne(
          field,
          'INVALID',
          "A shop's owner needs a passkey or an authenticator app: ask them to add one first",
        );
      }
      const now = this.now();
      const member = (id: string) =>
        and(eq(memberships.userId, id), eq(memberships.shopId, shopId));
      await tx
        .update(memberships)
        .set({ role: 'manager', updatedAt: now })
        .where(member(actor.userId));
      await tx.update(memberships).set({ role: 'owner', updatedAt: now }).where(member(userId));
      await this.recordEvent(tx, actor.userId, 'shop_handed_over', client);
      await this.recordEvent(tx, userId, 'shop_received', client);
      const staff = await this.staffIn(tx, shopId);
      return {
        ok: true,
        value: {
          owner: staff.find((each) => each.userId === userId)!,
          previousOwner: staff.find((each) => each.userId === actor.userId)!,
        },
      };
    });
  }

  /** Removes a staff member of a role the acting member manages: the shop is closed to them. */
  async remove(
    actor: { userId: string },
    shopId: string,
    userId: string,
    client: ClientInfo = {},
  ): Promise<MutationResult<{ userId: string; role: StaffRole }>> {
    type Result = MutationResult<{ userId: string; role: StaffRole }>;
    return this.db.transaction(async (tx): Promise<Result> => {
      const acting = await actingRole(tx, actor.userId, shopId);
      const target = await memberOf(tx, userId, shopId);
      if (!target) return failOne(['id'], 'NOT_FOUND', 'Staff member not found');
      if (userId === actor.userId) {
        return failOne(['id'], 'INVALID', 'You are removed by the owner');
      }
      const denied = mayManage(acting, target.role, ['id']);
      if (denied) return denied;
      await tx
        .delete(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.shopId, shopId)));
      await this.recordEvent(tx, actor.userId, 'staff_removed', client);
      return { ok: true, value: { userId, role: target.role } };
    });
  }

  /** What an invitation's link says, while it can be accepted; null otherwise. */
  async preview(token: string): Promise<InvitationPreview | null> {
    if (!INVITATION_TOKEN_PATTERN.test(token)) return null;
    const [row] = await this.db
      .select({ invitation: invitations, shop: shops.name, inviter: users.name })
      .from(invitations)
      .innerJoin(shops, and(eq(shops.id, invitations.shopId), eq(shops.status, 'active')))
      .innerJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.tokenHash, sha256(token)), pending(this.now())));
    if (!row || !isStaffRole(row.invitation.role)) return null;
    return {
      shop: { name: row.shop },
      role: row.invitation.role,
      invitedBy: row.inviter,
      expiresAt: row.invitation.expiresAt,
    };
  }

  /**
   * Accepts an invitation for the signed-in user: they work in the shop from now on, in its
   * role. It is spent, and a user who works there already keeps the role they have.
   */
  async accept(
    auth: { userId: string },
    token: string,
    client: ClientInfo = {},
  ): Promise<ShopAccess> {
    const invalid = new AuthError(
      'INVALID_INVITATION',
      404,
      'This invitation was accepted, taken back or has expired. Ask for a new one',
    );
    if (!INVITATION_TOKEN_PATTERN.test(token)) throw invalid;
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const [invitation] = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.tokenHash, sha256(token)), pending(now)))
        .for('update');
      const role = invitation?.role;
      if (!invitation || !role || !isStaffRole(role)) throw invalid;
      const [shop] = await tx
        .select({ name: shops.name })
        .from(shops)
        .where(and(eq(shops.id, invitation.shopId), eq(shops.status, 'active')));
      if (!shop) throw invalid;
      const joined = await tx
        .insert(memberships)
        .values({ userId: auth.userId, shopId: invitation.shopId, role })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId });
      if (joined.length === 0) {
        throw new AuthError('ALREADY_MEMBER', 409, 'You work in this shop already');
      }
      await tx
        .update(invitations)
        .set({ acceptedAt: now, acceptedBy: auth.userId })
        .where(eq(invitations.id, invitation.id));
      await this.recordEvent(tx, auth.userId, 'invitation_accepted', client);
      return {
        id: toPublicId('shop', invitation.shopId),
        name: shop.name,
        role,
        mfaRequired: MFA_REQUIRED_ROLES.has(role),
      };
    });
  }

  private async staffIn(tx: Executor, shopId: string): Promise<StaffMemberRecord[]> {
    const rows = await tx
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.shopId, shopId), eq(memberships.status, 'active')));
    return rows.flatMap((row) => (isStaffRole(row.role) ? [{ ...row, role: row.role }] : []));
  }

  private async recordEvent(
    executor: Executor,
    userId: string,
    kind: string,
    client: ClientInfo,
  ): Promise<void> {
    await executor.insert(authEvents).values({
      id: newId(),
      userId,
      kind,
      ip: ipOf(client),
      userAgent: userAgentOf(client),
      occurredAt: this.now(),
    });
  }
}

/** Neither accepted, taken back nor expired at `now`. */
function pending(now: Date) {
  return and(
    isNull(invitations.acceptedAt),
    isNull(invitations.revokedAt),
    gt(invitations.expiresAt, now),
  );
}

/** The acting member's role in the shop, locked so that no one changes it meanwhile. */
async function actingRole(tx: Tx, userId: string, shopId: string): Promise<StaffRole | null> {
  const member = await memberOf(tx, userId, shopId);
  return member?.role ?? null;
}

async function memberOf(
  tx: Tx,
  userId: string,
  shopId: string,
): Promise<{ role: StaffRole } | null> {
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
  return row && isStaffRole(row.role) ? { role: row.role } : null;
}

/** Why `acting` may not manage `role`, at `field`; null when it may. */
function mayManage(
  acting: StaffRole | null,
  role: string,
  field: string[],
): MutationResult<never> | null {
  if (!acting || managedRoles(acting).length === 0) {
    return failOne(field, 'INVALID', 'Only the owner and managers manage staff');
  }
  if (role === 'owner') {
    return failOne(field, 'INVALID', 'A shop has one owner, who is never invited or changed so');
  }
  if (!isStaffRole(role)) return failOne(field, 'INVALID', 'Not a staff role');
  if (!managedRoles(acting).includes(role)) {
    return failOne(field, 'INVALID', 'Only the owner invites and manages managers');
  }
  return null;
}

/** Whether the account has an authenticator app or a passkey. */
async function hasSecondFactor(tx: Executor, userId: string): Promise<boolean> {
  const [app] = await tx
    .select({ confirmedAt: totpCredentials.confirmedAt })
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId));
  if (app?.confirmedAt) return true;
  const [key] = await tx
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .limit(1);
  return key !== undefined;
}

async function nameOf(tx: Executor, userId: string): Promise<string> {
  const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return row?.name ?? '';
}

function toInvitation(
  row: typeof invitations.$inferSelect,
  inviter: string,
): StaffInvitationRecord | null {
  if (!isStaffRole(row.role)) return null;
  return {
    id: row.id,
    role: row.role,
    note: row.note,
    email: row.email,
    invitedBy: { userId: row.invitedBy, name: inviter },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
