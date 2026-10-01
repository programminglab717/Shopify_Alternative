// Drizzle mirror of db/migrations/0002_identity.sql and 0069_passkeys.sql, which are the source of
// truth.
import {
  bigint,
  boolean,
  customType,
  integer,
  pgSchema,
  primaryKey,
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
  email: text('email').notNull(),
  emailVerifiedAt: at('email_verified_at'),
  name: text('name').notNull(),
  phoneE164: text('phone_e164'),
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
  userAgent: text('user_agent'),
  ip: inet('ip'),
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
  purpose: text('purpose', { enum: ['register', 'sign_in'] }).notNull(),
  userId: uuid('user_id'),
  expiresAt: at('expires_at').notNull(),
  usedAt: at('used_at'),
  createdAt: at('created_at').notNull().defaultNow(),
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
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.shopId] })],
);

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
  status: text('status').notNull(),
});
