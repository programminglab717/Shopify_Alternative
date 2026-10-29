import { InputChecker, failOne, type MutationResult } from '@hatti/api';
import { SecretBox, secretToken, sha256 } from '@hatti/crypto';
import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { OIDC_LIMITS, OidcRelyingParty, confirmedEmailOf, pkcePair } from './oidc.js';

// Single sign-on for a shop's staff (ADM-09, ADR-864): the organisation's identity provider, any
// that speaks OpenID Connect, signs its people in to the shop. The owner names its issuer, the
// client Hatti is registered as there, and the email domains the organisation's staff sign in
// with. A sign-in goes to the provider by the authorization code flow with PKCE; the provider's
// ID token, fetched back with the client's secret, counts once checked against its published
// keys, for that client, with the nonce sent, and its email of one of the shop's domains. Then
// the member of the shop with that email is signed in. No account is made: staff are invited
// first. The provider's addresses are fetched only where they are on the public internet.
//
// A domain is proved the shop's through DNS (ADR-919): a TXT record of the shop's token at
// _hatti-sso.<domain>. A proved domain is one shop's alone: sign-ins by email of it go there,
// and no other shop names it. A domain no shop proved goes, as before, to the shop that named
// it last.

export const SSO_LIMITS = {
  domains: 10,
  /** How long a sign-in at the provider may take. */
  stateMs: 10 * 60_000,
  /** How long the admin has to trade the provider's answer for a session. */
  handoffMs: 2 * 60_000,
  /** How long the provider has to answer Hatti. */
  timeoutMs: OIDC_LIMITS.timeoutMs,
  /** How long a provider's configuration is kept. */
  discoveryMs: OIDC_LIMITS.discoveryMs,
  clockToleranceSeconds: OIDC_LIMITS.clockToleranceSeconds,
} as const;

/** The TXT record that proves a domain a shop's (ADR-919): at `_hatti-sso.<domain>`. */
export const SSO_PROOF = {
  label: '_hatti-sso',
  prefix: 'hatti-sso=',
  /** How often a proved domain is looked up again (ADR-934). */
  recheckMs: 24 * 60 * 60 * 1000,
  /** How long its record may be gone before the domain is no longer proved the shop's. */
  graceMs: 3 * 24 * 60 * 60 * 1000,
} as const;

/** One of the shop's email domains, and whether DNS proved it the shop's. */
export interface ShopSsoDomain {
  domain: string;
  /** Where its TXT record goes: `_hatti-sso.zari.pk`. */
  recordName: string;
  provedAt: Date | null;
  /**
   * Since when a proved domain's record is gone from DNS (ADR-934): three days on, the domain is
   * no longer proved the shop's. Null while it is there.
   */
  missingSince: Date | null;
}

/** What looking a proved domain up again came to (ADR-934). */
export type SsoDomainCheck = 'proved' | 'missing' | 'unproved' | 'unanswered';

/** A proved domain due a look again, and the record it should show (ADR-934). */
export interface SsoDomainDue {
  domain: string;
  proofToken: string;
  /** The shop it is proved for, and since when its record is gone, if it is (ADR-938). */
  shopId: string;
  missingSince: Date | null;
}

/**
 * Proved domains due a look again at `at`, across shops, those looked at longest ago first,
 * `limit` at most (ADR-934): through identity's own function, which the app login may run.
 */
export async function ssoDomainsToRecheck(
  db: Pick<Db, 'execute'>,
  at: Date,
  limit: number,
): Promise<SsoDomainDue[]> {
  const due = new Date(at.getTime() - SSO_PROOF.recheckMs).toISOString();
  const { rows } = await db.execute<{
    domain: string;
    proof_token: string;
    shop_id: string;
    missing_since: Date | string | null;
  }>(sql`
    SELECT domain, proof_token, shop_id, missing_since
      FROM identity.sso_domains_due(${due}::timestamptz, ${limit})`);
  return rows.map((row) => ({
    domain: row.domain,
    proofToken: row.proof_token,
    shopId: row.shop_id,
    missingSince: row.missing_since === null ? null : new Date(row.missing_since),
  }));
}

/**
 * Looks proved `due` up again at `at`, through `lookup` (ADR-934): its shop's token there, it
 * stays proved; gone, it is said missing since now, and three days missing it is no longer
 * proved the shop's. A lookup that fails changes nothing but when it was last looked at.
 */
export async function recheckSsoDomain(
  db: Pick<Db, 'execute'>,
  due: SsoDomainDue,
  lookup: TxtLookup,
  at: Date,
): Promise<SsoDomainCheck> {
  let found: boolean | null;
  try {
    const texts = await lookup(recordNameOf(due.domain));
    found = texts.some((text) => text.trim() === SSO_PROOF.prefix + due.proofToken);
  } catch {
    found = null;
  }
  const { rows } = await db.execute<{ check: SsoDomainCheck }>(sql`
    SELECT identity.sso_domain_checked(
             ${due.domain}, ${at.toISOString()}::timestamptz, ${found}::boolean,
             make_interval(secs => ${SSO_PROOF.graceMs / 1000})) AS check`);
  return rows[0]!.check;
}

/** A host's TXT records, as DNS gives them. */
export type TxtLookup = (host: string) => Promise<string[]>;

export interface SsoOptions {
  /** Tests' providers run on this machine: allows http and private addresses. */
  allowPrivateAddresses?: boolean;
}

export interface ShopSsoSettings {
  issuer: string;
  clientId: string;
  /** The client secret's last four characters. */
  secretHint: string;
  emailDomains: string[];
  /** Each email domain, and whether it is proved the shop's. */
  domains: ShopSsoDomain[];
  /** The TXT record's value that proves a domain the shop's: `hatti-sso=<token>`. */
  proofRecord: string;
  required: boolean;
  providerMfa: boolean;
  updatedAt: Date;
}

export interface ShopSsoInput {
  issuer: string;
  clientId: string;
  /** Needed the first time; blank keeps the one kept. */
  clientSecret?: string | null;
  emailDomains: readonly string[];
  required: boolean;
  providerMfa: boolean;
}

/** Why a sign-in through the provider did not happen. */
export type SsoProblem =
  'no_sso' | 'unreachable' | 'expired' | 'refused' | 'invalid' | 'not_member';

/** A sign-in the provider answered for, to begin the member's session with. */
export interface SsoHandoff {
  userId: string;
  shopId: string;
  providerMfa: boolean;
}

type SettingsRow = {
  issuer: string;
  client_id: string;
  client_secret: string;
  email_domains: string[];
  required: boolean;
  provider_mfa: boolean;
  proof_token: string;
  updated_at: Date | string;
};

const recordNameOf = (domain: string) => `${SSO_PROOF.label}.${domain}`;

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const sealedFor = (shopId: string) => `shop_sso:${shopId}`;

/** The email's domain, lowercased; null for no email. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at > 0
    ? email
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : null;
}

/** A shop's single sign-on: its settings, kept by its owner, and its staff's sign-ins. */
export class ShopSsoService {
  readonly #db: Db;
  readonly #box: SecretBox;
  readonly #now: () => Date;
  readonly #oidc: OidcRelyingParty;

  constructor(options: {
    db: Db;
    secretBox: SecretBox;
    now?: () => Date;
    sso?: SsoOptions | null;
  }) {
    this.#db = options.db;
    this.#box = options.secretBox;
    this.#now = options.now ?? (() => new Date());
    this.#oidc = new OidcRelyingParty({
      allowPrivateAddresses: options.sso?.allowPrivateAddresses ?? false,
    });
  }

  /** The shop's settings, its secret's last characters alone; null while it has none. */
  async settingsOf(shopId: string): Promise<ShopSsoSettings | null> {
    const row = await this.#row(shopId);
    return row && this.#settings(shopId, row, await this.#proved(shopId));
  }

  /** Sets the shop's provider and domains, or changes them: the owner's to do. */
  async save(shopId: string, input: ShopSsoInput): Promise<MutationResult<ShopSsoSettings>> {
    const check = new InputChecker();
    const issuer = check.text(['input', 'issuer'], input.issuer, { required: true, max: 500 });
    if (issuer && !this.#oidc.addressOk(issuer)) {
      check.addMessage(['input', 'issuer'], 'INVALID', 'Give the provider’s https address');
    }
    const clientId = check.text(['input', 'clientId'], input.clientId, {
      required: true,
      max: 255,
    });
    const secret = check.text(['input', 'clientSecret'], input.clientSecret, { max: 1_000 });
    const domains = [
      ...new Set(input.emailDomains.map((each) => each.trim().toLowerCase())),
    ].filter(Boolean);
    if (domains.length === 0) {
      check.addMessage(
        ['input', 'emailDomains'],
        'BLANK',
        'Give the domain your staff’s emails are of',
      );
    }
    if (domains.length > SSO_LIMITS.domains) {
      check.add(['input', 'emailDomains'], 'TOO_MANY', `can be ${SSO_LIMITS.domains} at most`);
    }
    const wrong = domains.find((each) => !DOMAIN.test(each));
    if (wrong) check.addMessage(['input', 'emailDomains'], 'INVALID', `${wrong} isn't a domain`);
    if (!check.ok) return { ok: false, errors: check.errors };
    const { rows: taken } = await this.#db.execute<{ domain: string }>(sql`
      SELECT domain FROM identity.sso_domains
       WHERE domain = ANY (${sql.param(domains)}::text[]) AND shop_id <> ${shopId}
       ORDER BY domain LIMIT 1`);
    if (taken[0]) {
      return failOne(
        ['input', 'emailDomains'],
        'TAKEN',
        `${taken[0].domain} is proved another shop's, through DNS`,
      );
    }
    const current = await this.#row(shopId);
    if (!secret && !current) {
      return failOne(['input', 'clientSecret'], 'BLANK', "Client secret can't be blank");
    }
    const sealed = secret
      ? this.#box.encrypt(Buffer.from(secret, 'utf8'), sealedFor(shopId))
      : current!.client_secret;
    await this.#db.execute(sql`
      INSERT INTO identity.shop_sso
             (shop_id, issuer, client_id, client_secret, email_domains, required, provider_mfa)
      VALUES (${shopId}, ${issuer!.replace(/\/+$/, '')}, ${clientId!}, ${sealed},
              ${sql.param(domains)}::text[], ${input.required}, ${input.providerMfa})
      ON CONFLICT (shop_id) DO UPDATE
         SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
             client_secret = EXCLUDED.client_secret, email_domains = EXCLUDED.email_domains,
             required = EXCLUDED.required, provider_mfa = EXCLUDED.provider_mfa,
             updated_at = now()`);
    // A domain the shop no longer names is no longer proved its.
    await this.#db.execute(sql`
      DELETE FROM identity.sso_domains
       WHERE shop_id = ${shopId} AND NOT (domain = ANY (${sql.param(domains)}::text[]))`);
    return { ok: true, value: (await this.settingsOf(shopId))! };
  }

  /** Ends the shop's single sign-on: its staff sign in their own ways again. */
  async remove(shopId: string): Promise<boolean> {
    const { rows } = await this.#db.execute<{ shop_id: string }>(sql`
      DELETE FROM identity.shop_sso WHERE shop_id = ${shopId} RETURNING shop_id`);
    return rows.length > 0;
  }

  /**
   * Looks in DNS for the shop's token at each of its domains not yet proved, through `lookup`:
   * one that shows it is proved the shop's, unless another shop proved it first. The settings
   * after; null while the shop has none.
   */
  async proveDomains(shopId: string, lookup: TxtLookup): Promise<ShopSsoSettings | null> {
    const row = await this.#row(shopId);
    if (!row) return null;
    const proved = await this.#proved(shopId);
    const expected = SSO_PROOF.prefix + row.proof_token;
    for (const domain of row.email_domains.filter((each) => !proved.has(each))) {
      // A DNS failure proves nothing, and is not the owner's to read: the domain stays unproved.
      const texts = await lookup(recordNameOf(domain)).catch(() => [] as string[]);
      if (!texts.some((text) => text.trim() === expected)) continue;
      await this.#db.execute(sql`
        INSERT INTO identity.sso_domains (domain, shop_id, proved_at)
        VALUES (${domain}, ${shopId}, ${this.#now()})
        ON CONFLICT (domain) DO NOTHING`);
    }
    return this.#settings(shopId, row, await this.#proved(shopId));
  }

  /**
   * Starts a sign-in through the provider of the shop whose domains `email` is of, or of
   * `shopId`: the provider's address to send the browser to, and the state the admin keeps to
   * know the answer is its own.
   */
  async start(
    input: { email?: string | null; shopId?: string | null },
    callbackUrl: string,
  ): Promise<{ url: string; state: string } | { problem: SsoProblem }> {
    const domain = input.email ? domainOf(input.email) : null;
    // A domain proved a shop's goes to it alone; one no shop proved, to the shop that named it.
    const byDomain = sql`(shop_id = (SELECT shop_id FROM identity.sso_domains WHERE domain = ${domain})
       OR (${domain} = ANY (email_domains)
           AND NOT EXISTS (SELECT 1 FROM identity.sso_domains WHERE domain = ${domain})))`;
    const { rows } = await this.#db.execute<{ shop_id: string } & SettingsRow>(sql`
      SELECT shop_id, issuer, client_id, client_secret, email_domains, required, provider_mfa,
             proof_token, updated_at
        FROM identity.shop_sso
       WHERE ${input.shopId ? sql`shop_id = ${input.shopId}` : byDomain}
       ORDER BY updated_at DESC LIMIT 1`);
    const found = rows[0];
    if (!found) return { problem: 'no_sso' };
    const discovery = await this.#oidc.discover(found.issuer);
    if (!discovery) return { problem: 'unreachable' };
    const state = secretToken('', 32);
    const nonce = secretToken('', 32);
    const { verifier, challenge } = pkcePair();
    const now = this.#now();
    await this.#db.execute(sql`
      DELETE FROM identity.sso_logins WHERE expires_at < ${new Date(now.getTime() - 3_600_000)}`);
    await this.#db.execute(sql`
      INSERT INTO identity.sso_logins (state_hash, shop_id, nonce, code_verifier, expires_at)
      VALUES (${sha256(state)}, ${found.shop_id}, ${nonce}, ${verifier},
              ${new Date(now.getTime() + SSO_LIMITS.stateMs)})`);
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: found.client_id,
      redirect_uri: callbackUrl,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(input.email && { login_hint: input.email }),
    }).toString();
    return { url: url.toString(), state };
  }

  /**
   * Takes the provider's answer: its code traded for the ID token, which is checked, then the
   * member of the shop with its email found. A code for the admin to trade for the session, once,
   * within two minutes; or why not.
   */
  async finish(
    answer: { code?: string | null; state?: string | null; error?: string | null },
    callbackUrl: string,
  ): Promise<{ handoff: string; shopId: string } | { problem: SsoProblem; shopId: string | null }> {
    if (!answer.state) return { problem: 'expired', shopId: null };
    const now = this.#now();
    const { rows } = await this.#db.execute<{
      shop_id: string;
      nonce: string;
      code_verifier: string;
    }>(sql`
      UPDATE identity.sso_logins SET expires_at = ${now}
       WHERE state_hash = ${sha256(answer.state)} AND expires_at > ${now} AND handoff_hash IS NULL
      RETURNING shop_id, nonce, code_verifier`);
    const login = rows[0];
    if (!login) return { problem: 'expired', shopId: null };
    const shopId = login.shop_id;
    if (answer.error || !answer.code) return { problem: 'refused', shopId };
    const settings = await this.#row(shopId);
    const discovery = settings && (await this.#oidc.discover(settings.issuer));
    if (!settings || !discovery) return { problem: 'unreachable', shopId };
    const checked = await this.#oidc.idTokenFor({
      discovery,
      clientId: settings.client_id,
      clientSecret: this.#box.decrypt(settings.client_secret, sealedFor(shopId)).toString('utf8'),
      code: answer.code,
      redirectUri: callbackUrl,
      verifier: login.code_verifier,
      nonce: login.nonce,
      now,
    });
    if ('problem' in checked) return { problem: checked.problem, shopId };
    const email = confirmedEmailOf(checked.payload);
    // Only an email of the organisation's own domains names a member: the owner vouched for them.
    // Not one proved another shop's: its people sign in there.
    const domain = email && domainOf(email);
    if (!email || !domain || !settings.email_domains.includes(domain)) {
      return { problem: 'not_member', shopId };
    }
    const { rows: elsewhere } = await this.#db.execute(sql`
      SELECT 1 FROM identity.sso_domains WHERE domain = ${domain} AND shop_id <> ${shopId}`);
    if (elsewhere.length > 0) return { problem: 'not_member', shopId };
    const { rows: members } = await this.#db.execute<{ id: string }>(sql`
      SELECT u.id FROM identity.users u
        JOIN identity.memberships m ON m.user_id = u.id AND m.shop_id = ${shopId}
         AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > now())
       WHERE lower(u.email) = ${email} AND u.status = 'active'
       LIMIT 1`);
    const member = members[0];
    if (!member) return { problem: 'not_member', shopId };
    const handoff = secretToken('', 32);
    await this.#db.execute(sql`
      UPDATE identity.sso_logins
         SET handoff_hash = ${sha256(handoff)}, user_id = ${member.id},
             expires_at = ${new Date(now.getTime() + SSO_LIMITS.handoffMs)}
       WHERE state_hash = ${sha256(answer.state)}`);
    return { handoff, shopId };
  }

  /** The sign-in a handoff code stands for, once, within its two minutes; null otherwise. */
  async takeHandoff(handoff: string): Promise<SsoHandoff | null> {
    const now = this.#now();
    const { rows } = await this.#db.execute<{
      user_id: string;
      shop_id: string;
      provider_mfa: boolean;
    }>(sql`
      UPDATE identity.sso_logins l SET redeemed_at = ${now}
        FROM identity.shop_sso s
       WHERE l.handoff_hash = ${sha256(handoff)} AND l.redeemed_at IS NULL
         AND l.expires_at > ${now} AND s.shop_id = l.shop_id
      RETURNING l.user_id, l.shop_id, s.provider_mfa`);
    const row = rows[0];
    return row ? { userId: row.user_id, shopId: row.shop_id, providerMfa: row.provider_mfa } : null;
  }

  async #row(shopId: string): Promise<SettingsRow | null> {
    const { rows } = await this.#db.execute<SettingsRow>(sql`
      SELECT issuer, client_id, client_secret, email_domains, required, provider_mfa,
             proof_token, updated_at
        FROM identity.shop_sso WHERE shop_id = ${shopId}`);
    return rows[0] ?? null;
  }

  /** The domains proved the shop's, when, and since when their record is gone (ADR-934). */
  async #proved(shopId: string): Promise<Map<string, { at: Date; missingSince: Date | null }>> {
    const { rows } = await this.#db.execute<{
      domain: string;
      proved_at: Date | string;
      missing_since: Date | string | null;
    }>(sql`
      SELECT domain, proved_at, missing_since FROM identity.sso_domains WHERE shop_id = ${shopId}`);
    return new Map(
      rows.map((row) => [
        row.domain,
        {
          at: new Date(row.proved_at),
          missingSince: row.missing_since === null ? null : new Date(row.missing_since),
        },
      ]),
    );
  }

  #settings(
    shopId: string,
    row: SettingsRow,
    proved: Map<string, { at: Date; missingSince: Date | null }>,
  ): ShopSsoSettings {
    const secret = this.#box.decrypt(row.client_secret, sealedFor(shopId)).toString('utf8');
    return {
      issuer: row.issuer,
      clientId: row.client_id,
      secretHint: secret.slice(-4),
      emailDomains: row.email_domains,
      domains: row.email_domains.map((domain) => ({
        domain,
        recordName: recordNameOf(domain),
        provedAt: proved.get(domain)?.at ?? null,
        missingSince: proved.get(domain)?.missingSince ?? null,
      })),
      proofRecord: SSO_PROOF.prefix + row.proof_token,
      required: row.required,
      providerMfa: row.provider_mfa,
      updatedAt: new Date(row.updated_at),
    };
  }
}
