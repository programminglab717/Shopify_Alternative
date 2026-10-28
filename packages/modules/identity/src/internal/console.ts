import { secretToken, sha256 } from '@hatti/crypto';
import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { OidcRelyingParty, confirmedEmailOf, pkcePair } from './oidc.js';

// Hatti's console (ADR-876): Hatti's own people sign in through Hatti's identity provider, by the
// authorization code flow with PKCE, a state and a nonce, as a shop's staff do through theirs
// (ADR-864). The provider is Hatti's own, which asks its people for their security keys; where it
// says how they signed in, the methods Hatti asks for must be among them. Its email must be one
// of Hatti's support agents' accounts (ADR-156). The session reaches the console alone, lasts a
// working day and ends after half an hour unused; what is done in it is logged first.

export const CONSOLE_LIMITS = {
  /** How long a sign-in at the provider may take. */
  stateMs: 10 * 60_000,
  /** How long the console has to trade the provider's answer for a session. */
  handoffMs: 2 * 60_000,
  /** A session's longest: a working day. */
  sessionMs: 10 * 60 * 60_000,
  /** A session unused this long ends. */
  idleMs: 30 * 60_000,
  /** How often a session's use is written down. */
  seenEveryMs: 60_000,
  actions: 100,
} as const;

/** Hatti's identity provider, as the console signs in through it. */
export interface ConsoleSignInSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The console's address: "https://console.hatti.pk". */
  consoleUrl: string;
  /**
   * How the provider must say each agent signed in, its `amr`: "hwk" for a hardware key. None
   * checked where empty, for a provider that doesn't say and enforces keys itself.
   */
  requiredAmr?: readonly string[];
  /** Tests' providers run on this machine. */
  allowPrivateAddresses?: boolean;
}

/** Why a sign-in to the console did not happen. */
export type ConsoleSignInProblem =
  'unavailable' | 'unreachable' | 'expired' | 'refused' | 'invalid' | 'not_agent' | 'no_key';

/** One of Hatti's people signed in to the console. */
export interface ConsoleAgent {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  expiresAt: Date;
}

/** Something done in the console, as its log keeps it. */
export interface ConsoleActionRecord {
  id: string;
  email: string;
  action: string;
  subject: string | null;
  details: Record<string, unknown>;
  at: Date;
}

const amrOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

export class ConsoleAuthService {
  readonly #db: Db;
  readonly #settings: ConsoleSignInSettings | null;
  readonly #now: () => Date;
  readonly #oidc: OidcRelyingParty;

  constructor(options: { db: Db; console?: ConsoleSignInSettings | null; now?: () => Date }) {
    this.#db = options.db;
    this.#settings = options.console ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#oidc = new OidcRelyingParty({
      allowPrivateAddresses: options.console?.allowPrivateAddresses ?? false,
    });
  }

  /** Whether Hatti's provider is set up for the console. */
  get available(): boolean {
    return this.#settings !== null;
  }

  /** Where the provider sends the browser back: the console's address, which passes it to the core. */
  get callbackUrl(): string | null {
    return this.#settings ? `${this.#settings.consoleUrl}/console/api/auth/callback` : null;
  }

  /** Where the console's pages are, for the provider's answer to go on to. */
  get consoleUrl(): string | null {
    return this.#settings?.consoleUrl ?? null;
  }

  /** Starts a sign-in: the provider's address to send the browser to, and the state the tab keeps. */
  async start(
    loginHint?: string | null,
  ): Promise<{ url: string; state: string } | { problem: ConsoleSignInProblem }> {
    const settings = this.#settings;
    if (!settings) return { problem: 'unavailable' };
    const discovery = await this.#oidc.discover(settings.issuer);
    if (!discovery) return { problem: 'unreachable' };
    const state = secretToken('', 32);
    const nonce = secretToken('', 32);
    const { verifier, challenge } = pkcePair();
    const now = this.#now();
    await this.#db.execute(sql`
      DELETE FROM identity.console_logins
       WHERE expires_at < ${new Date(now.getTime() - 3_600_000)}`);
    await this.#db.execute(sql`
      INSERT INTO identity.console_logins (state_hash, nonce, code_verifier, expires_at)
      VALUES (${sha256(state)}, ${nonce}, ${verifier},
              ${new Date(now.getTime() + CONSOLE_LIMITS.stateMs)})`);
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: settings.clientId,
      redirect_uri: this.callbackUrl!,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(loginHint && { login_hint: loginHint }),
    }).toString();
    return { url: url.toString(), state };
  }

  /**
   * Takes the provider's answer: its ID token checked, then the agent with its email found. A
   * code for the console to trade for the session, once, within two minutes; or why not.
   */
  async finish(answer: {
    code?: string | null;
    state?: string | null;
    error?: string | null;
  }): Promise<{ handoff: string } | { problem: ConsoleSignInProblem }> {
    const settings = this.#settings;
    if (!settings) return { problem: 'unavailable' };
    if (!answer.state) return { problem: 'expired' };
    const now = this.#now();
    const { rows } = await this.#db.execute<{ nonce: string; code_verifier: string }>(sql`
      UPDATE identity.console_logins SET expires_at = ${now}
       WHERE state_hash = ${sha256(answer.state)} AND expires_at > ${now} AND handoff_hash IS NULL
      RETURNING nonce, code_verifier`);
    const login = rows[0];
    if (!login) return { problem: 'expired' };
    if (answer.error || !answer.code) return { problem: 'refused' };
    const discovery = await this.#oidc.discover(settings.issuer);
    if (!discovery) return { problem: 'unreachable' };
    const checked = await this.#oidc.idTokenFor({
      discovery,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      code: answer.code,
      redirectUri: this.callbackUrl!,
      verifier: login.code_verifier,
      nonce: login.nonce,
      now,
    });
    if ('problem' in checked) return { problem: checked.problem };
    const required = settings.requiredAmr ?? [];
    const used = amrOf(checked.payload.amr);
    if (required.length > 0 && !required.some((each) => used.includes(each))) {
      return { problem: 'no_key' };
    }
    const email = confirmedEmailOf(checked.payload);
    if (!email) return { problem: 'not_agent' };
    const { rows: agents } = await this.#db.execute<{ id: string }>(sql`
      SELECT u.id FROM identity.users u
        JOIN identity.support_agents a ON a.user_id = u.id AND a.status = 'active'
       WHERE lower(u.email) = ${email} AND u.status = 'active'
       LIMIT 1`);
    const agent = agents[0];
    if (!agent) return { problem: 'not_agent' };
    const handoff = secretToken('', 32);
    await this.#db.execute(sql`
      UPDATE identity.console_logins
         SET handoff_hash = ${sha256(handoff)}, user_id = ${agent.id},
             expires_at = ${new Date(now.getTime() + CONSOLE_LIMITS.handoffMs)}
       WHERE state_hash = ${sha256(answer.state)}`);
    return { handoff };
  }

  /** The session a handoff code stands for, once, within its two minutes; null otherwise. */
  async redeem(
    handoff: string,
    client: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ token: string; agent: ConsoleAgent } | null> {
    const now = this.#now();
    const { rows } = await this.#db.execute<{ user_id: string }>(sql`
      UPDATE identity.console_logins SET redeemed_at = ${now}
       WHERE handoff_hash = ${sha256(handoff)} AND redeemed_at IS NULL AND expires_at > ${now}
      RETURNING user_id`);
    const userId = rows[0]?.user_id;
    if (!userId) return null;
    const token = secretToken('hcs_', 32);
    const { rows: sessions } = await this.#db.execute<{ id: string; email: string }>(sql`
      INSERT INTO identity.console_sessions
             (token_hash, user_id, email, created_at, last_seen_at, expires_at, ip, user_agent)
      SELECT ${sha256(token)}, u.id, lower(u.email), ${now}, ${now},
             ${new Date(now.getTime() + CONSOLE_LIMITS.sessionMs)},
             ${client.ip?.slice(0, 64) ?? null}, ${client.userAgent?.slice(0, 300) ?? null}
        FROM identity.users u WHERE u.id = ${userId}
      RETURNING id, email`);
    if (!sessions[0]) return null;
    const agent = await this.agentOf(token);
    return agent ? { token, agent } : null;
  }

  /**
   * The agent a console session's token is: while it lasts, has been used in the last half hour,
   * and its account is still an agent's; null otherwise. Its use is written down.
   */
  async agentOf(token: string): Promise<ConsoleAgent | null> {
    if (!token.startsWith('hcs_')) return null;
    const now = this.#now();
    const { rows } = await this.#db.execute<{
      id: string;
      user_id: string;
      email: string;
      name: string;
      expires_at: Date | string;
      last_seen_at: Date | string;
    }>(sql`
      SELECT s.id, s.user_id, s.email, u.name, s.expires_at, s.last_seen_at
        FROM identity.console_sessions s
        JOIN identity.users u ON u.id = s.user_id AND u.status = 'active'
        JOIN identity.support_agents a ON a.user_id = s.user_id AND a.status = 'active'
       WHERE s.token_hash = ${sha256(token)} AND s.ended_at IS NULL AND s.expires_at > ${now}
         AND s.last_seen_at > ${new Date(now.getTime() - CONSOLE_LIMITS.idleMs)}`);
    const row = rows[0];
    if (!row) return null;
    if (now.getTime() - new Date(row.last_seen_at).getTime() >= CONSOLE_LIMITS.seenEveryMs) {
      await this.#db.execute(sql`
        UPDATE identity.console_sessions SET last_seen_at = ${now} WHERE id = ${row.id}`);
    }
    return {
      sessionId: row.id,
      userId: row.user_id,
      email: row.email,
      name: row.name,
      expiresAt: new Date(row.expires_at),
    };
  }

  /** Ends a console session: its token reaches nothing more. */
  async signOut(token: string): Promise<void> {
    await this.#db.execute(sql`
      UPDATE identity.console_sessions SET ended_at = ${this.#now()}
       WHERE token_hash = ${sha256(token)} AND ended_at IS NULL`);
  }

  /** Writes down what an agent is about to do, before it is done. */
  async record(
    agent: ConsoleAgent,
    action: string,
    subject: string | null,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#db.execute(sql`
      INSERT INTO identity.console_actions (session_id, user_id, email, action, subject, details, at)
      VALUES (${agent.sessionId}, ${agent.userId}, ${agent.email}, ${action}, ${subject},
              ${JSON.stringify(details)}::jsonb, ${this.#now()})`);
  }

  /** What was done in the console, the latest first; of one subject where named. */
  async actions(
    options: { subject?: string | null; first?: number } = {},
  ): Promise<ConsoleActionRecord[]> {
    const first = Math.min(Math.max(options.first ?? 50, 1), CONSOLE_LIMITS.actions);
    const { rows } = await this.#db.execute<{
      id: string;
      email: string;
      action: string;
      subject: string | null;
      details: Record<string, unknown>;
      at: Date | string;
    }>(sql`
      SELECT id, email, action, subject, details, at FROM identity.console_actions
       ${options.subject ? sql`WHERE subject = ${options.subject}` : sql``}
       ORDER BY at DESC, id DESC LIMIT ${first}`);
    return rows.map((row) => ({ ...row, at: new Date(row.at) }));
  }
}
