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
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  accessRequestEmail,
  invitationEmail,
  type AccountEmailLanguage,
} from './account-emails.js';
import { suppressed } from './email-feedback.js';
import { AuthError } from './errors.js';
import { developmentStoreTransferred } from './partners.service.js';
import {
  ipOf,
  normalizeEmail,
  userAgentOf,
  type AccountEmails,
  type ClientInfo,
  type ShopAccess,
} from './identity.service.js';
import {
  accessRequests,
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
  /** The most days a collaborator's access lasts (ADR-487). */
  accessDays: 90,
  /** How long a request for access waits to be decided (ADR-488). */
  accessRequestMs: 7 * 24 * 3_600_000,
  /** Characters in what a request for access says of who asks and what for. */
  requestMessage: 300,
  /** Requests for access an account makes in a day, to any shops. */
  requestsPerDay: 10,
  /** Requests for access a shop has waiting at once. */
  waitingRequests: 20,
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
  /** When a collaborator's access ends (ADR-487); null for staff for good. */
  expiresAt: Date | null;
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
  /** Their role in the shop, which says what of its work is theirs (ADR-247). */
  role: StaffRole;
}

/**
 * Ends up to `limit` collaborators' memberships past their end (ADR-487), across shops, through
 * identity.end_expired_memberships, as the worker does it: never identity's tables. How many.
 */
export async function endExpiredMemberships(
  db: Pick<Db, 'execute'>,
  limit: number,
): Promise<number> {
  const { rows } = await db.execute<{ ended: number }>(
    sql`SELECT identity.end_expired_memberships(${limit}) AS ended`,
  );
  return Number(rows[0]?.ended ?? 0);
}

/** A shop whose staff a number is, as Hatti's support WhatsApp number finds them (ADR-560). */
export interface StaffOfPhoneRecord {
  userId: string;
  shopId: string;
  /** What Hatti's words to them are in (ADR-194). */
  language: 'en' | 'ur';
}

/**
 * The shops whose staff `phone`, E.164, is (ADR-560): those of the active account that proved it
 * with a code, where its membership is active and has not ended, the earliest joined first; none
 * for a number no account proved. Across shops, as WhatsApp's webhook knows none, through
 * identity.staff_of_phone: never identity's tables.
 */
export async function staffOfPhone(
  db: Pick<Db, 'execute'>,
  phone: string,
): Promise<StaffOfPhoneRecord[]> {
  const { rows } = await db.execute<{ user_id: string; shop_id: string; language: 'en' | 'ur' }>(
    sql`SELECT user_id, shop_id, language FROM identity.staff_of_phone(${phone})`,
  );
  return rows.map((row) => ({ userId: row.user_id, shopId: row.shop_id, language: row.language }));
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
      ? [
          {
            userId: row.user_id,
            name: row.name,
            phone: row.phone,
            language: row.language,
            role: row.role,
          },
        ]
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
  /** For a collaborator (ADR-487): the days the access it gives lasts; null for good. */
  accessDays: number | null;
}

/** What an invitation's link says before it is accepted. */
export interface InvitationPreview {
  shop: { name: string };
  role: StaffRole;
  invitedBy: string;
  expiresAt: Date;
  /** For a collaborator (ADR-487): the days the access lasts once accepted; null for good. */
  accessDays: number | null;
}

/** An account's request to work in a shop for some days (ADR-488). */
export interface AccessRequestRecord {
  id: string;
  shop: { id: string; name: string };
  requester: { userId: string; name: string; email: string | null };
  role: StaffRole;
  accessDays: number;
  /** Who asks and what for, as they put it. */
  message: string | null;
  status: 'pending' | 'approved' | 'declined' | 'expired';
  createdAt: Date;
  /** Until when it waits to be decided. */
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
        expiresAt: memberships.expiresAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.shopId, shopId), eq(memberships.status, 'active'), current(this.now())),
      )
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
      /** For a collaborator (ADR-487): the days, 1 to 90, the access lasts; for good unless given. */
      accessDays?: number | null;
    },
    client: ClientInfo = {},
    limit: PlanLimit | null = null,
  ): Promise<
    MutationResult<{ invitation: StaffInvitationRecord; token: string; emailed: boolean }>
  > {
    const accessDays = input.accessDays ?? null;
    if (
      accessDays !== null &&
      (!Number.isInteger(accessDays) || accessDays < 1 || accessDays > STAFF_LIMITS.accessDays)
    ) {
      return failOne(
        ['accessDays'],
        'INVALID',
        `Access lasts 1 to ${STAFF_LIMITS.accessDays} days`,
      );
    }
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
      const made = await this.createInvitationIn(
        tx,
        actor,
        shopId,
        input.role,
        note,
        email,
        limit,
        null,
        accessDays,
      );
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
          row.accessDays,
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
    accessDays: number | null = null,
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
        accessDays,
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
      if (target.expiresAt) {
        return failOne(field, 'INVALID', "A collaborator's access ends: the shop goes to staff");
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
      // A partner's development store opens as it goes to its client (ADR-504).
      await developmentStoreTransferred(tx, shopId, userId, now);
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
      accessDays: row.invitation.accessDays,
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
      await endedMembershipCleared(tx, auth.userId, invitation.shopId, now);
      const joined = await tx
        .insert(memberships)
        .values({
          userId: auth.userId,
          shopId: invitation.shopId,
          role,
          // A collaborator's access ends by itself (ADR-487).
          expiresAt: invitation.accessDays
            ? new Date(now.getTime() + invitation.accessDays * 24 * 3_600_000)
            : null,
        })
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

  /**
   * Asks the shop at `input.shop`, its handle, for access in a role for 1 to 90 days, for the
   * signed-in account, as an agency or a freelancer does (ADR-488). The request waits 7 days for
   * the shop's owner, or a manager for the roles below them, to approve or decline; the owner is
   * emailed of it. An account asks 10 a day at most, one at a time of a shop, and a shop has 20
   * waiting at most.
   */
  async requestAccess(
    auth: { userId: string },
    input: { shop: string; role: string; accessDays: number; message?: string | null },
    client: ClientInfo = {},
  ): Promise<AccessRequestRecord> {
    const role = input.role;
    if (!isStaffRole(role) || role === 'owner') {
      throw new AuthError('INVALID_REQUEST', 400, 'Ask for a role other than the owner');
    }
    const days = input.accessDays;
    if (!Number.isInteger(days) || days < 1 || days > STAFF_LIMITS.accessDays) {
      throw new AuthError(
        'INVALID_REQUEST',
        400,
        `Access lasts 1 to ${STAFF_LIMITS.accessDays} days`,
      );
    }
    const message = input.message?.trim() || null;
    if (message && message.length > STAFF_LIMITS.requestMessage) {
      throw new AuthError(
        'INVALID_REQUEST',
        400,
        `Say it in ${STAFF_LIMITS.requestMessage} characters or fewer`,
      );
    }
    const handle = input.shop.trim().toLowerCase();
    const request = await this.db.transaction(async (tx) => {
      const now = this.now();
      const [shop] = await tx
        .select({ id: shops.id, name: shops.name })
        .from(shops)
        .where(and(eq(shops.handle, handle), eq(shops.status, 'active')));
      if (!shop) throw new AuthError('SHOP_NOT_FOUND', 404, 'No shop on Hatti has that address');
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.userId, auth.userId), eq(memberships.shopId, shop.id), current(now)),
        );
      if (member) throw new AuthError('ALREADY_MEMBER', 409, 'You work in this shop already');
      const [asked] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.userId, auth.userId),
            gt(accessRequests.createdAt, new Date(now.getTime() - 24 * 3_600_000)),
          ),
        );
      if ((asked?.count ?? 0) >= STAFF_LIMITS.requestsPerDay) {
        throw new AuthError('TOO_MANY_REQUESTS', 429, 'Too many requests today. Try tomorrow');
      }
      await expireRequests(tx, now, eq(accessRequests.shopId, shop.id));
      const [waiting] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(accessRequests)
        .where(and(eq(accessRequests.shopId, shop.id), eq(accessRequests.status, 'pending')));
      if ((waiting?.count ?? 0) >= STAFF_LIMITS.waitingRequests) {
        throw new AuthError(
          'TOO_MANY_REQUESTS',
          429,
          'This shop has too many requests waiting. Ask its owner to invite you',
        );
      }
      const [row] = await tx
        .insert(accessRequests)
        .values({
          id: newId(),
          shopId: shop.id,
          userId: auth.userId,
          role,
          accessDays: days,
          message,
          createdAt: now,
          expiresAt: new Date(now.getTime() + STAFF_LIMITS.accessRequestMs),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        throw new AuthError(
          'REQUEST_WAITING',
          409,
          'You asked this shop already: wait for its owner to decide',
        );
      }
      await this.recordEvent(tx, auth.userId, 'access_requested', client);
      const [requester] = await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, auth.userId));
      return toRequest(row, shop.name, auth.userId, requester ?? { name: '', email: null })!;
    });
    await this.emailOwnerOf(request);
    return request;
  }

  /** The signed-in account's own requests for access of the last 30 days, the newest first. */
  async accessRequestsBy(auth: { userId: string }): Promise<AccessRequestRecord[]> {
    const now = this.now();
    const rows = await this.db
      .select({ request: accessRequests, shop: shops.name, name: users.name, email: users.email })
      .from(accessRequests)
      .innerJoin(shops, eq(shops.id, accessRequests.shopId))
      .innerJoin(users, eq(users.id, accessRequests.userId))
      .where(
        and(
          eq(accessRequests.userId, auth.userId),
          gt(accessRequests.createdAt, new Date(now.getTime() - 30 * 24 * 3_600_000)),
        ),
      )
      .orderBy(desc(accessRequests.createdAt), desc(accessRequests.id))
      .limit(50);
    return rows.flatMap((row) => {
      const request = toRequest(lapsed(row.request, now), row.shop, row.request.userId, row);
      return request ? [request] : [];
    });
  }

  /** The requests for access waiting on the shop, the oldest first (ADR-488). */
  async accessRequestsOf(shopId: string): Promise<AccessRequestRecord[]> {
    const rows = await this.db
      .select({ request: accessRequests, shop: shops.name, name: users.name, email: users.email })
      .from(accessRequests)
      .innerJoin(shops, eq(shops.id, accessRequests.shopId))
      .innerJoin(users, eq(users.id, accessRequests.userId))
      .where(
        and(
          eq(accessRequests.shopId, shopId),
          eq(accessRequests.status, 'pending'),
          gt(accessRequests.expiresAt, this.now()),
        ),
      )
      .orderBy(asc(accessRequests.createdAt), asc(accessRequests.id));
    return rows.flatMap((row) => {
      const request = toRequest(row.request, row.shop, row.request.userId, row);
      return request ? [request] : [];
    });
  }

  /**
   * Approves a request for access waiting on the shop, of a role the acting member manages, as
   * asked or in `role` and for `accessDays` given in its place: the account works in the shop
   * from now until those days are up (ADR-487). With `limit`, within the plan's staff (ADR-154).
   */
  async approveAccessRequest(
    actor: { userId: string },
    shopId: string,
    requestId: string,
    input: { role?: string | null; accessDays?: number | null } = {},
    client: ClientInfo = {},
    limit: PlanLimit | null = null,
  ): Promise<MutationResult<{ request: AccessRequestRecord; member: StaffMemberRecord }>> {
    type Result = MutationResult<{ request: AccessRequestRecord; member: StaffMemberRecord }>;
    const days = input.accessDays ?? null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > STAFF_LIMITS.accessDays)) {
      return failOne(
        ['accessDays'],
        'INVALID',
        `Access lasts 1 to ${STAFF_LIMITS.accessDays} days`,
      );
    }
    return this.db.transaction(async (tx): Promise<Result> => {
      const now = this.now();
      const row = await this.waitingRequest(tx, shopId, requestId, now);
      if (!row.ok) return row;
      const request = row.value;
      const role = input.role ?? request.role;
      const acting = await actingRole(tx, actor.userId, shopId);
      const denied = mayManage(acting, request.role, ['id']) ?? mayManage(acting, role, ['role']);
      if (denied) return denied;
      if (limit) {
        const [members] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(memberships)
          .where(
            and(eq(memberships.shopId, shopId), eq(memberships.status, 'active'), current(now)),
          );
        const [waiting] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(invitations)
          .where(and(eq(invitations.shopId, shopId), pending(now)));
        if ((members?.count ?? 0) + (waiting?.count ?? 0) >= limit.limit) {
          return failOne(
            ['id'],
            'TOO_MANY',
            planLimitMessage(limit, 'member of staff', 'members of staff'),
          );
        }
      }
      await endedMembershipCleared(tx, request.userId, shopId, now);
      const accessDays = days ?? request.accessDays;
      const joined = await tx
        .insert(memberships)
        .values({
          userId: request.userId,
          shopId,
          role,
          expiresAt: new Date(now.getTime() + accessDays * 24 * 3_600_000),
        })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId });
      if (joined.length === 0) {
        return failOne(['id'], 'INVALID', 'They work in the shop already');
      }
      const [decided] = await tx
        .update(accessRequests)
        .set({ status: 'approved', role, accessDays, decidedAt: now, decidedBy: actor.userId })
        .where(eq(accessRequests.id, request.id))
        .returning();
      await this.recordEvent(tx, actor.userId, 'access_request_approved', client);
      const [member] = (await this.staffIn(tx, shopId)).filter(
        (each) => each.userId === request.userId,
      );
      const [shop] = await tx.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
      const [requester] = await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, request.userId));
      return {
        ok: true,
        value: {
          request: toRequest(decided!, shop?.name ?? '', request.userId, requester!)!,
          member: member!,
        },
      };
    });
  }

  /** Declines a request for access waiting on the shop, of a role the acting member manages. */
  async declineAccessRequest(
    actor: { userId: string },
    shopId: string,
    requestId: string,
    client: ClientInfo = {},
  ): Promise<MutationResult<AccessRequestRecord>> {
    return this.db.transaction(async (tx): Promise<MutationResult<AccessRequestRecord>> => {
      const now = this.now();
      const row = await this.waitingRequest(tx, shopId, requestId, now);
      if (!row.ok) return row;
      const denied = mayManage(await actingRole(tx, actor.userId, shopId), row.value.role, ['id']);
      if (denied) return denied;
      const [decided] = await tx
        .update(accessRequests)
        .set({ status: 'declined', decidedAt: now, decidedBy: actor.userId })
        .where(eq(accessRequests.id, row.value.id))
        .returning();
      await this.recordEvent(tx, actor.userId, 'access_request_declined', client);
      const [shop] = await tx.select({ name: shops.name }).from(shops).where(eq(shops.id, shopId));
      const [requester] = await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, row.value.userId));
      return {
        ok: true,
        value: toRequest(decided!, shop?.name ?? '', row.value.userId, requester!)!,
      };
    });
  }

  /** The shop's request still waiting, locked; refused as not found otherwise. */
  private async waitingRequest(
    tx: Tx,
    shopId: string,
    requestId: string,
    now: Date,
  ): Promise<MutationResult<typeof accessRequests.$inferSelect>> {
    const [row] = await tx
      .select()
      .from(accessRequests)
      .where(and(eq(accessRequests.id, requestId), eq(accessRequests.shopId, shopId)))
      .for('update');
    if (!row) return failOne(['id'], 'NOT_FOUND', 'Request not found');
    if (row.status !== 'pending') return failOne(['id'], 'INVALID', 'It was decided already');
    if (row.expiresAt <= now) {
      return failOne(['id'], 'INVALID', 'It has expired: they can ask again, or invite them');
    }
    return { ok: true, value: row };
  }

  /**
   * Emails the shop's owner of a request for access (ADR-488), at the email their account proved
   * where Hatti may send to it, in their language, with the staff page's link. After the request
   * commits: one that could not go leaves it standing.
   */
  private async emailOwnerOf(request: AccessRequestRecord): Promise<void> {
    if (!this.emails) return;
    const [owner] = await this.db
      .select({ email: users.email, language: users.language })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.shopId, request.shop.id),
          eq(memberships.role, 'owner'),
          eq(memberships.status, 'active'),
          eq(users.status, 'active'),
          isNotNull(users.emailVerifiedAt),
        ),
      );
    if (!owner?.email || (await suppressed(this.db, owner.email))) return;
    const link =
      `${this.emails.adminUrl.replace(/\/+$/, '')}/` +
      `${toPublicId('shop', request.shop.id)}/settings/staff`;
    await this.emails.sender
      .send(
        accessRequestEmail({
          to: owner.email,
          requester: request.requester.name,
          shop: request.shop.name,
          role: request.role,
          days: request.accessDays,
          link,
          language: owner.language,
        }),
      )
      .catch(() => false);
  }

  private async staffIn(tx: Executor, shopId: string): Promise<StaffMemberRecord[]> {
    const rows = await tx
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: memberships.role,
        joinedAt: memberships.createdAt,
        expiresAt: memberships.expiresAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.shopId, shopId), eq(memberships.status, 'active'), current(this.now())),
      );
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

/** Memberships not past their end (ADR-487): staff for good, and collaborators still in time. */
function current(now: Date) {
  return or(isNull(memberships.expiresAt), gt(memberships.expiresAt, now));
}

/**
 * Deletes the account's membership of the shop if it ended (ADR-487), not swept yet, so that it
 * joins again rather than being taken for one who works there.
 */
async function endedMembershipCleared(
  tx: Tx,
  userId: string,
  shopId: string,
  now: Date,
): Promise<void> {
  await tx
    .delete(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.shopId, shopId),
        isNotNull(memberships.expiresAt),
        lte(memberships.expiresAt, now),
      ),
    );
}

/** Marks the requests waiting past their 7 days, of those `where` picks, as expired (ADR-488). */
async function expireRequests(tx: Tx, now: Date, where: SQL | undefined): Promise<void> {
  await tx
    .update(accessRequests)
    .set({ status: 'expired', decidedAt: now })
    .where(and(where, eq(accessRequests.status, 'pending'), lte(accessRequests.expiresAt, now)));
}

/** A request as it stands at `now`: one waiting past its 7 days reads as expired. */
function lapsed(
  row: typeof accessRequests.$inferSelect,
  now: Date,
): typeof accessRequests.$inferSelect {
  return row.status === 'pending' && row.expiresAt <= now ? { ...row, status: 'expired' } : row;
}

function toRequest(
  row: typeof accessRequests.$inferSelect,
  shop: string,
  userId: string,
  requester: { name: string; email: string | null },
): AccessRequestRecord | null {
  if (!isStaffRole(row.role)) return null;
  return {
    id: row.id,
    shop: { id: row.shopId, name: shop },
    requester: { userId, name: requester.name, email: requester.email },
    role: row.role,
    accessDays: row.accessDays,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
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
): Promise<{ role: StaffRole; expiresAt: Date | null } | null> {
  const [row] = await tx
    .select({ role: memberships.role, expiresAt: memberships.expiresAt })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.shopId, shopId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('update');
  return row && isStaffRole(row.role) ? { role: row.role, expiresAt: row.expiresAt } : null;
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
    accessDays: row.accessDays,
  };
}
