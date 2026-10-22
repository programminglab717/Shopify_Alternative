// Drizzle mirror of db/migrations/0002_identity.sql, 0069_passkeys.sql,
// 0070_staff_invitations.sql, 0100_support_access.sql, 0103_phone_sign_up.sql,
// 0107_google_sign_in.sql, 0108_account_emails.sql, 0109_invitations_by_email.sql,
// 0111_email_feedback.sql, 0112_email_change.sql and 0271_custom_roles.sql, which are the source of
// truth.
import {
  bigint,
  boolean,
  customType,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

const at = (name: string) => timestamp(name, { withTimezone: true });

export const identitySchema = pgSchema('identity');

export const users = identitySchema.table('users', {
  id: uuid('id').primaryKey(),
  /** Null for an account opened with a phone alone (ADR-159). */
  email: text('email'),
  emailVerifiedAt: at('email_verified_at'),
  name: text('name').notNull(),
  phoneE164: text('phone_e164'),
  /** When the number was proved with a code sent to it: then it signs the account in. */
  phoneVerifiedAt: at('phone_verified_at'),
  /** What Hatti's emails and messages to its owner are in (ADR-194). */
  language: text('language', { enum: ['en', 'ur'] })
    .notNull()
    .default('en'),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const passwordCredentials = identitySchema.table('password_credentials', {
  userId: uuid('user_id').primaryKey(),
  hash: text('hash').notNull(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const totpCredentials = identitySchema.table('totp_credentials', {
  userId: uuid('user_id').primaryKey(),
  secretEncrypted: text('secret_encrypted'),
  confirmedAt: at('confirmed_at'),
  pendingSecretEncrypted: text('pending_secret_encrypted'),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const recoveryCodes = identitySchema.table(
  'recovery_codes',
  {
    userId: uuid('user_id').notNull(),
    codeHash: bytea('code_hash').notNull(),
    usedAt: at('used_at'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.codeHash] })],
);

export const sessions = identitySchema.table('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  accessTokenHash: bytea('access_token_hash').notNull(),
  accessExpiresAt: at('access_expires_at').notNull(),
  refreshTokenHash: bytea('refresh_token_hash').notNull(),
  previousRefreshTokenHash: bytea('previous_refresh_token_hash'),
  refreshedAt: at('refreshed_at'),
  mfaVerifiedAt: at('mfa_verified_at'),
  /** When its user last proved who they are: signing in, or re-authenticating since (ADR-103). */
  authenticatedAt: at('authenticated_at').notNull().defaultNow(),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  /**
   * The device it signed in from, as its client names it (ADR-179): SHA-256 of the account's ID
   * with the ID the client keeps for the device; null where the client keeps none.
   */
  deviceHash: bytea('device_hash'),
  createdAt: at('created_at').notNull().defaultNow(),
  lastUsedAt: at('last_used_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  revokedAt: at('revoked_at'),
  revokedReason: text('revoked_reason'),
});

export const mfaChallenges = identitySchema.table('mfa_challenges', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
  createdAt: at('created_at').notNull().defaultNow(),
  /** The WebAuthn challenge a passkey of the user's answers, where they have one (ADR-100). */
  passkeyChallenge: text('passkey_challenge'),
});

/** Codes sent to prove numbers, to sign in or open an account with them (ADR-159). */
export const phoneCodes = identitySchema.table('phone_codes', {
  id: uuid('id').primaryKey(),
  phone: text('phone').notNull(),
  channel: text('channel', { enum: ['whatsapp', 'sms'] }).notNull(),
  codeHash: bytea('code_hash').notNull(),
  attempts: smallint('attempts').notNull().default(0),
  expiresAt: at('expires_at').notNull(),
  verifiedAt: at('verified_at'),
  signUpTokenHash: bytea('sign_up_token_hash'),
  usedAt: at('used_at'),
  ip: inet('ip'),
  createdAt: at('created_at').notNull().defaultNow(),
});

/**
 * Links sent to prove an account's email or reset its password (ADR-165), and to prove the email
 * it changes to (ADR-172).
 */
export const emailTokens = identitySchema.table('email_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  purpose: text('purpose', { enum: ['verify_email', 'reset_password', 'change_email'] }).notNull(),
  /** Where the link went: for a change, the email the account changes to. */
  email: text('email').notNull(),
  /** The language its email was written in. */
  language: text('language', { enum: ['en', 'ur'] })
    .notNull()
    .default('en'),
  tokenHash: bytea('token_hash').notNull(),
  expiresAt: at('expires_at').notNull(),
  /** When it was used, or another link of its kind sent in its place. */
  usedAt: at('used_at'),
  ip: inet('ip'),
  createdAt: at('created_at').notNull().defaultNow(),
});

/**
 * Addresses Hatti sends no more email to (ADR-170): one whose server said it takes no mail, for
 * good, or whose recipient marked an email of Hatti's as spam.
 */
export const emailSuppressions = identitySchema.table('email_suppressions', {
  email: text('email').primaryKey(),
  reason: text('reason', { enum: ['bounce', 'complaint'] }).notNull(),
  /** What the server said, or the kind of complaint. */
  detail: text('detail'),
  /** SES's ID for the feedback last heard of the address. */
  feedbackId: text('feedback_id').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** Google accounts that sign in to accounts (ADR-164), one to an account. */
export const googleAccounts = identitySchema.table('google_accounts', {
  /** Google's ID for the account (`sub`), which never changes and is never another's. */
  subject: text('subject').primaryKey(),
  userId: uuid('user_id').notNull(),
  /** Its email at Google, as Google last gave it. */
  email: text('email').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  lastSignedInAt: at('last_signed_in_at'),
});

/** The nonces Google's sign-in starts with, each answered once before it expires. */
export const googleNonces = identitySchema.table('google_nonces', {
  nonce: text('nonce').primaryKey(),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** Passkeys staff sign in with (ADR-100). */
export const passkeys = identitySchema.table('passkeys', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  /** As WebAuthn gives it, base64url. */
  credentialId: text('credential_id').notNull(),
  /** COSE-encoded. */
  publicKey: bytea('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: text('transports').array().notNull().default([]),
  multiDevice: boolean('multi_device').notNull(),
  backedUp: boolean('backed_up').notNull(),
  name: text('name').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  lastUsedAt: at('last_used_at'),
});

/** WebAuthn challenges, each answered once before it expires. */
export const passkeyChallenges = identitySchema.table('passkey_challenges', {
  id: uuid('id').primaryKey(),
  challenge: text('challenge').notNull(),
  purpose: text('purpose', { enum: ['register', 'sign_in', 'reauthenticate'] }).notNull(),
  userId: uuid('user_id'),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** Invitations to work in a shop (ADR-101), accepted once by whoever holds the link. */
export const invitations = identitySchema.table('invitations', {
  id: uuid('id').primaryKey(),
  shopId: uuid('shop_id').notNull(),
  role: text('role').notNull(),
  note: text('note'),
  /** Where Hatti emailed its link (ADR-167); null when the inviter shares it alone. */
  email: text('email'),
  tokenHash: bytea('token_hash').notNull(),
  invitedBy: uuid('invited_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  acceptedAt: at('accepted_at'),
  acceptedBy: uuid('accepted_by'),
  revokedAt: at('revoked_at'),
  /** For a collaborator (ADR-487): the days the access it gives lasts; null for good. */
  accessDays: integer('access_days'),
  /** The custom role it gives (ADR-578), `role` its preset; null for a preset's. */
  customRoleId: uuid('custom_role_id'),
});

/** An account's request to work in a shop for some days (ADR-488). */
export const accessRequests = identitySchema.table('access_requests', {
  id: uuid('id').primaryKey(),
  shopId: uuid('shop_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull(),
  accessDays: integer('access_days').notNull(),
  message: text('message'),
  status: text('status', { enum: ['pending', 'approved', 'declined', 'expired'] })
    .notNull()
    .default('pending'),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  decidedAt: at('decided_at'),
  decidedBy: uuid('decided_by'),
});

export const memberships = identitySchema.table(
  'memberships',
  {
    userId: uuid('user_id').notNull(),
    shopId: uuid('shop_id').notNull(),
    role: text('role').notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    /** When a collaborator's access ends (ADR-487); null for good. */
    expiresAt: at('expires_at'),
    /** Their custom role (ADR-578), `role` its preset; null for a preset's. */
    customRoleId: uuid('custom_role_id'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.shopId] })],
);

/** A shop's own staff role (ADR-578), made from a preset, holding some of what it holds. */
export const customRoles = identitySchema.table('custom_roles', {
  id: uuid('id').primaryKey(),
  shopId: uuid('shop_id').notNull(),
  name: text('name').notNull(),
  basedOn: text('based_on').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  capabilities: text('capabilities').array().notNull().default([]),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** Hatti's own support agents (ADR-156), added and removed by Hatti. */
export const supportAgents = identitySchema.table('support_agents', {
  userId: uuid('user_id').primaryKey(),
  status: text('status', { enum: ['active', 'removed'] })
    .notNull()
    .default('active'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** Each time a shop's owner let Hatti's support look (ADR-156). */
export const supportGrants = identitySchema.table('support_grants', {
  id: uuid('id').primaryKey(),
  shopId: uuid('shop_id').notNull(),
  grantedBy: uuid('granted_by').notNull(),
  access: text('access', { enum: ['read'] })
    .notNull()
    .default('read'),
  note: text('note'),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  endedAt: at('ended_at'),
  endedBy: uuid('ended_by'),
});

export const authEvents = identitySchema.table('auth_events', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id'),
  kind: text('kind').notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  occurredAt: at('occurred_at').notNull().defaultNow(),
});

/** Read-only view of the shop directory, for listing a user's shops. */
export const shops = pgSchema('control').table('shops', {
  id: uuid('id').notNull(),
  name: text('name').notNull(),
  handle: text('handle').notNull(),
  status: text('status').notNull(),
  /** When its owner closed it (ADR-740); null while open. */
  closedAt: at('closed_at'),
  updatedAt: at('updated_at'),
});
