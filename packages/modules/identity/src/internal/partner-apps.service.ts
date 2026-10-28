import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACCESS_SCOPES,
  MFA_REQUIRED_ROLES,
  REAUTHENTICATION_WINDOW_MS,
  isStaffRole,
  type AccessScope,
} from '@hatti/api';
import type { Db } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { memberAccess } from './custom-roles.js';
import { AuthError } from './errors.js';
import type { AuthenticatedSession } from './identity.service.js';

// Public apps (DEV-05, ADR-851): a partner registers an app that shops install, and Hatti's OAuth
// lets an owner or a manager approve it for their shop, as Shopify's does. The app sends the
// merchant to the admin's consent page; approved, it gets a code back at one of its redirect
// URLs, which it trades with its client secret for a token of the shop's, made by the apps module
// as a custom app's is. Until Hatti lists it, an app installs on its partner's own development
// stores alone. Secrets and codes are kept as their digests.

export const PARTNER_APP_LIMITS = {
  apps: 10,
  name: 100,
  url: 300,
  redirects: 5,
  /** How long a merchant's approval waits to be traded for a token. */
  codeMs: 10 * 60 * 1000,
} as const;

/** The roles that install apps: owners and managers, as make custom apps. */
const INSTALLERS = new Set(['owner', 'manager']);

export interface PartnerAppRecord {
  id: string;
  name: string;
  appUrl: string;
  redirectUrls: string[];
  scopes: string[];
  clientId: string;
  listed: boolean;
  createdAt: Date;
}

export interface PartnerAppInput {
  name: string;
  appUrl: string;
  redirectUrls: readonly string[];
  scopes: readonly string[];
}

/** What the consent page shows of an app asking to be installed. */
export interface AppConsent {
  appId: string;
  name: string;
  appUrl: string;
  partner: string;
  /** The scopes it asks for, of those it registered. */
  scopes: AccessScope[];
  listed: boolean;
}

/** An approval traded for a token: whose shop, with which scopes, for which app. */
export interface RedeemedAuthorization {
  shopId: string;
  scopes: string[];
  app: { id: string; name: string };
}

type AppRow = {
  id: string;
  name: string;
  app_url: string;
  redirect_urls: string[];
  scopes: string[];
  client_id: string;
  listed_at: Date | string | null;
  created_at: Date | string;
};

const digestOf = (secret: string) => createHash('sha256').update(secret).digest();

const toRecord = (row: AppRow): PartnerAppRecord => ({
  id: toPublicId('partnerApp', row.id),
  name: row.name,
  appUrl: row.app_url,
  redirectUrls: row.redirect_urls,
  scopes: row.scopes,
  clientId: row.client_id,
  listed: row.listed_at !== null,
  createdAt: new Date(row.created_at),
});

const invalid = (message: string) => new AuthError('INVALID_INPUT', 422, message);

/** An https address, as given; or why not. */
function httpsOf(value: string, what: string): string {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(`${what} is not an address`);
  }
  if (url.protocol !== 'https:' || text.length > PARTNER_APP_LIMITS.url || url.hash) {
    throw invalid(`${what} is an https address of ${PARTNER_APP_LIMITS.url} characters at most`);
  }
  return text;
}

/** The scopes asked, known, each once and in the API's order. */
function scopesOf(value: readonly string[]): AccessScope[] {
  const asked = new Set(value.map((scope) => scope.trim().toLowerCase()));
  const unknown = [...asked].filter(
    (scope) => !(ACCESS_SCOPES as readonly string[]).includes(scope),
  );
  if (asked.size === 0) throw invalid('An app asks for at least one scope');
  if (unknown.length > 0) throw invalid(`No such scope: ${unknown.join(', ')}`);
  return ACCESS_SCOPES.filter((scope) => asked.has(scope));
}

function checked(input: PartnerAppInput) {
  const name = input.name.trim();
  if (!name || name.length > PARTNER_APP_LIMITS.name) {
    throw invalid(`Name the app in ${PARTNER_APP_LIMITS.name} characters at most`);
  }
  const redirects = [...new Set(input.redirectUrls.map((url) => httpsOf(url, 'A redirect URL')))];
  if (redirects.length === 0 || redirects.length > PARTNER_APP_LIMITS.redirects) {
    throw invalid(`Give 1 to ${PARTNER_APP_LIMITS.redirects} redirect URLs`);
  }
  return {
    name,
    appUrl: httpsOf(input.appUrl, "The app's URL"),
    redirects,
    scopes: scopesOf(input.scopes),
  };
}

export class PartnerAppsService {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(options: { db: Db; now?: () => Date }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  async #partnerId(auth: Pick<AuthenticatedSession, 'userId'>): Promise<string> {
    const { rows } = await this.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM identity.partners WHERE user_id = ${auth.userId}`);
    if (!rows[0]) throw new AuthError('NOT_PARTNER', 403, "Join Hatti's partner programme first");
    return rows[0].user_id;
  }

  /** The partner's apps, oldest first. */
  async apps(auth: Pick<AuthenticatedSession, 'userId'>): Promise<PartnerAppRecord[]> {
    const partnerId = await this.#partnerId(auth);
    const { rows } = await this.db.execute<AppRow>(sql`
      SELECT id, name, app_url, redirect_urls, scopes, client_id, listed_at, created_at
        FROM identity.partner_apps WHERE partner_id = ${partnerId}
       ORDER BY created_at, id`);
    return rows.map(toRecord);
  }

  /** A new app of the partner's, with its client secret, given this once. */
  async create(
    auth: Pick<AuthenticatedSession, 'userId'>,
    input: PartnerAppInput,
  ): Promise<{ app: PartnerAppRecord; clientSecret: string }> {
    const partnerId = await this.#partnerId(auth);
    const app = checked(input);
    const { rows: counted } = await this.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM identity.partner_apps WHERE partner_id = ${partnerId}`);
    if (counted[0]!.count >= PARTNER_APP_LIMITS.apps) {
      throw new AuthError(
        'TOO_MANY_APPS',
        422,
        `A partner has ${PARTNER_APP_LIMITS.apps} apps at most`,
      );
    }
    const clientId = `hca_${randomBytes(16).toString('hex')}`;
    const clientSecret = `hcs_${randomBytes(32).toString('base64url')}`;
    const { rows } = await this.db.execute<AppRow>(sql`
      INSERT INTO identity.partner_apps
             (partner_id, name, app_url, redirect_urls, scopes, client_id, client_secret_digest)
      VALUES (${partnerId}, ${app.name}, ${app.appUrl}, ${sql.param(app.redirects)}::text[],
              ${sql.param(app.scopes)}::text[], ${clientId}, ${digestOf(clientSecret)})
      RETURNING id, name, app_url, redirect_urls, scopes, client_id, listed_at, created_at`);
    return { app: toRecord(rows[0]!), clientSecret };
  }

  /** Changes the partner's app `id`; its client ID and secret stay as they are. */
  async update(
    auth: Pick<AuthenticatedSession, 'userId'>,
    id: string,
    input: PartnerAppInput,
  ): Promise<PartnerAppRecord> {
    const partnerId = await this.#partnerId(auth);
    const app = checked(input);
    const { rows } = await this.db.execute<AppRow>(sql`
      UPDATE identity.partner_apps
         SET name = ${app.name}, app_url = ${app.appUrl},
             redirect_urls = ${sql.param(app.redirects)}::text[],
             scopes = ${sql.param(app.scopes)}::text[], updated_at = now()
       WHERE id = ${id} AND partner_id = ${partnerId}
      RETURNING id, name, app_url, redirect_urls, scopes, client_id, listed_at, created_at`);
    if (!rows[0]) throw new AuthError('NOT_FOUND', 404, 'No such app');
    return toRecord(rows[0]);
  }

  /** For Hatti's review (ADR-851): every app, with its partner, those not yet listed first. */
  async all(): Promise<(PartnerAppRecord & { partner: string })[]> {
    const { rows } = await this.db.execute<AppRow & { business_name: string }>(sql`
      SELECT a.id, a.name, a.app_url, a.redirect_urls, a.scopes, a.client_id, a.listed_at,
             a.created_at, p.business_name
        FROM identity.partner_apps a JOIN identity.partners p ON p.user_id = a.partner_id
       ORDER BY a.listed_at IS NOT NULL, a.created_at, a.id`);
    return rows.map((row) => ({ ...toRecord(row), partner: row.business_name }));
  }

  /** Hatti's review (ADR-851): the app `clientId` listed for every shop, or taken back to its partner's. */
  async review(clientId: string, listed: boolean): Promise<PartnerAppRecord | null> {
    const { rows } = await this.db.execute<AppRow>(sql`
      UPDATE identity.partner_apps
         SET listed_at = ${listed ? sql`coalesce(listed_at, now())` : sql`NULL`}, updated_at = now()
       WHERE client_id = ${clientId}
      RETURNING id, name, app_url, redirect_urls, scopes, client_id, listed_at, created_at`);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * What the consent page shows of the app `clientId`, asking for `scope` and to send the
   * merchant back to `redirectUri`: refused where the app has no such redirect, or asks beyond
   * what it registered.
   */
  async consent(clientId: string, redirectUri: string, scope: string): Promise<AppConsent> {
    const { rows } = await this.db.execute<AppRow & { business_name: string }>(sql`
      SELECT a.id, a.name, a.app_url, a.redirect_urls, a.scopes, a.client_id, a.listed_at,
             a.created_at, p.business_name
        FROM identity.partner_apps a JOIN identity.partners p ON p.user_id = a.partner_id
       WHERE a.client_id = ${clientId}`);
    const app = rows[0];
    if (!app) throw new AuthError('NOT_FOUND', 404, 'No app has that client ID');
    if (!app.redirect_urls.includes(redirectUri)) {
      throw invalid('That redirect URL is not one the app registered');
    }
    const scopes = scopesOf(scope.split(/[\s,]+/).filter(Boolean));
    const beyond = scopes.filter((each) => !app.scopes.includes(each));
    if (beyond.length > 0) throw invalid(`The app did not register ${beyond.join(', ')}`);
    return {
      appId: app.id,
      name: app.name,
      appUrl: app.app_url,
      partner: app.business_name,
      scopes,
      listed: app.listed_at !== null,
    };
  }

  /**
   * The signed-in owner's or manager's approval of the app for `shopId`, as the consent page
   * asked it: where to send them, with the code and the shop, and `state` as the app gave it. An
   * app not yet listed installs on its partner's own development stores alone; none is given
   * more than the member's role may do.
   */
  async authorize(
    auth: Pick<AuthenticatedSession, 'userId' | 'mfaVerified' | 'authenticatedAt'>,
    request: {
      clientId: string;
      redirectUri: string;
      scope: string;
      state: string;
      shopId: string;
    },
  ): Promise<string> {
    const consent = await this.consent(request.clientId, request.redirectUri, request.scope);
    const { rows: members } = await this.db.execute<{
      role: string;
      custom_role_id: string | null;
      custom_scopes: string[] | null;
    }>(sql`
      SELECT m.role, m.custom_role_id, r.scopes AS custom_scopes
        FROM identity.memberships m
        JOIN control.shops s ON s.id = m.shop_id AND s.status = 'active'
        LEFT JOIN identity.custom_roles r ON r.id = m.custom_role_id
       WHERE m.user_id = ${auth.userId} AND m.shop_id = ${request.shopId}`);
    const member = members[0];
    const role = member?.role;
    if (!member || !role || !INSTALLERS.has(role) || !isStaffRole(role)) {
      throw new AuthError('FORBIDDEN', 403, "Only the shop's owner or a manager installs apps");
    }
    // As a custom app is made (ADR-395): with the second factor the role needs, lately proved.
    if (MFA_REQUIRED_ROLES.has(role) && !auth.mfaVerified) {
      throw new AuthError('MFA_REQUIRED', 403, 'Turn on two-step verification and sign in again');
    }
    if (this.now().getTime() - auth.authenticatedAt.getTime() >= REAUTHENTICATION_WINDOW_MS) {
      throw new AuthError(
        'REAUTHENTICATION_REQUIRED',
        403,
        'Confirm it is you first (POST /auth/reauthenticate), then try again',
      );
    }
    const allowed = new Set<string>(
      memberAccess(
        role,
        member.custom_role_id === null
          ? null
          : { scopes: member.custom_scopes, capabilities: null },
      ).scopes,
    );
    // A role that writes a resource reads it too.
    const beyond = consent.scopes.filter(
      (scope) =>
        !allowed.has(scope) &&
        !(scope.startsWith('read_') && allowed.has(`write_${scope.slice('read_'.length)}`)),
    );
    if (beyond.length > 0)
      throw new AuthError('FORBIDDEN', 403, `Your role can't give ${beyond.join(', ')}`);
    if (!consent.listed) {
      const { rows: own } = await this.db.execute<{ shop_id: string }>(sql`
        SELECT s.shop_id FROM identity.partner_stores s
          JOIN identity.partner_apps a ON a.partner_id = s.partner_id
         WHERE a.id = ${consent.appId} AND s.shop_id = ${request.shopId}
           AND s.kind = 'development' AND s.transferred_at IS NULL`);
      if (!own[0]) {
        throw new AuthError(
          'NOT_LISTED',
          403,
          "Hatti hasn't listed this app yet: it installs on its partner's development stores alone",
        );
      }
    }
    const code = randomBytes(24).toString('base64url');
    await this.db.execute(sql`
      INSERT INTO identity.app_authorizations
             (code_digest, app_id, shop_id, user_id, scopes, redirect_uri, expires_at)
      VALUES (${digestOf(code)}, ${consent.appId}, ${request.shopId}, ${auth.userId},
              ${sql.param(consent.scopes)}::text[], ${request.redirectUri},
              ${new Date(this.now().getTime() + PARTNER_APP_LIMITS.codeMs).toISOString()})`);
    const back = new URL(request.redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('shop', toPublicId('shop', request.shopId));
    if (request.state) back.searchParams.set('state', request.state);
    return back.toString();
  }

  /**
   * Trades a merchant's approval for what the app's token gives: once, within ten minutes, by the
   * app it was given to, its client secret checked.
   */
  async redeem(request: {
    clientId: string;
    clientSecret: string;
    code: string;
  }): Promise<RedeemedAuthorization> {
    const refused = () =>
      new AuthError('INVALID_GRANT', 400, 'That code, client ID or secret is not good');
    const { rows } = await this.db.execute<{ id: string; name: string; digest: Buffer }>(sql`
      SELECT id, name, client_secret_digest AS digest FROM identity.partner_apps
       WHERE client_id = ${request.clientId}`);
    const app = rows[0];
    if (!app) throw refused();
    const given = digestOf(request.clientSecret);
    if (!timingSafeEqual(given, Buffer.from(app.digest))) throw refused();
    const { rows: codes } = await this.db.execute<{ shop_id: string; scopes: string[] }>(sql`
      UPDATE identity.app_authorizations SET used_at = now()
       WHERE code_digest = ${digestOf(request.code)} AND app_id = ${app.id}
         AND used_at IS NULL AND expires_at > ${this.now().toISOString()}
      RETURNING shop_id, scopes`);
    if (!codes[0]) throw refused();
    return {
      shopId: codes[0].shop_id,
      scopes: codes[0].scopes,
      app: { id: app.id, name: app.name },
    };
  }
}
