import { ApiError, authRequest, graphqlRequest, type Fetch } from '../api/client';

// A staff member's session with the core (ADR-020, ADR-265): opaque tokens from `/auth`, kept in
// the browser's storage so that the installed app stays signed in for the session's 30 days, and
// shared by the admin's tabs. A token is refreshed by one tab at a time, the others taking what it
// got: the core refuses a refresh token used twice.

/** Tokens as `/auth` gives them. */
export interface Tokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  session: { id: string; mfaVerified: boolean; authenticatedAt: string };
}

export type StaffRole =
  'owner' | 'manager' | 'confirmation_agent' | 'packer' | 'marketer' | 'accountant';

/** A shop the account works in, and its role there. */
export interface ShopAccess {
  id: string;
  name: string;
  role: StaffRole;
  /** Whether its role needs a second factor proved in the session. */
  mfaRequired: boolean;
}

export interface AccountUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  language: 'en' | 'ur';
  mfaEnabled: boolean;
  /** Whether the email was proved, by a link or by Google. */
  emailVerified?: boolean;
  /** Whether the number was proved with a code, which signs the account in. */
  phoneVerified?: boolean;
}

/** `GET /auth/me`. */
export interface Me {
  user: AccountUser;
  session: { id: string; mfaVerified: boolean; authenticatedAt: string };
  shops: ShopAccess[];
  /** The Google account that signs it in, if one is connected. */
  google?: { email: string; connectedAt: string } | null;
}

const STORAGE_KEY = 'hatti.session';
/** Refreshed this long before it runs out, so a request never leaves with a dying token. */
const EARLY_MS = 30_000;

/** Browser storage as the store needs it; missing or blocked storage keeps the session in memory. */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeStorage(): SessionStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseTokens(text: string | null): Tokens | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<Tokens>;
    return typeof value.accessToken === 'string' && typeof value.refreshToken === 'string'
      ? (value as Tokens)
      : null;
  } catch {
    return null;
  }
}

/** The session, as the admin's screens see it. */
export interface SessionSnapshot {
  signedIn: boolean;
  /** Whether a second factor was proved in this session. */
  mfaVerified: boolean;
}

const SIGNED_OUT: SessionSnapshot = { signedIn: false, mfaVerified: false };

export class SessionStore {
  #tokens: Tokens | null;
  #snapshot: SessionSnapshot;
  #refreshing: Promise<Tokens | null> | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly fetcher: Fetch,
    private readonly storage: SessionStorage | null = safeStorage(),
    private readonly now: () => number = Date.now,
  ) {
    this.#tokens = this.#read();
    this.#snapshot = this.#snapshotOf(this.#tokens);
  }

  /** For React's useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.#snapshot;

  /** Another tab signed in, refreshed or signed out: take what it kept. */
  sync(): void {
    this.#set(this.#read(), false);
  }

  /** Keeps the tokens a sign-in, sign-up or second factor gave. */
  signedIn(tokens: Tokens): void {
    this.#set(tokens);
  }

  /**
   * A second factor set up in this session proves it there and then (the core marks the session
   * so, without new tokens).
   */
  mfaProved(): void {
    const tokens = this.#tokens;
    if (tokens) this.#set({ ...tokens, session: { ...tokens.session, mfaVerified: true } });
  }

  /** Ends the session at the core, as far as it can be reached, and forgets it here. */
  async signOut(): Promise<void> {
    const tokens = this.#tokens;
    this.#set(null);
    if (!tokens) return;
    try {
      await authRequest(this.fetcher, '/auth/sign-out', {
        method: 'POST',
        accessToken: tokens.accessToken,
      });
    } catch {
      // Forgotten here all the same; the core lets it run out.
    }
  }

  /** A live access token, refreshed first when it is about to run out; null when signed out. */
  async accessToken(): Promise<string | null> {
    const tokens = this.#tokens;
    if (!tokens) return null;
    if (Date.parse(tokens.accessTokenExpiresAt) - EARLY_MS > this.now()) return tokens.accessToken;
    return (await this.refresh(tokens.refreshToken))?.accessToken ?? null;
  }

  /**
   * Swaps `used` for new tokens, once however many ask at once, in this tab and the others; null
   * when the session is over.
   */
  refresh(used = this.#tokens?.refreshToken): Promise<Tokens | null> {
    if (!used) return Promise.resolve(null);
    this.#refreshing ??= this.#exclusively(() => this.#refreshOnce(used)).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /** A call to `/auth` as the account, refreshed and tried once more on a 401. */
  async auth<T>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
  ): Promise<T> {
    return this.#withToken((accessToken) =>
      authRequest<T>(this.fetcher, path, { ...options, accessToken }),
    );
  }

  /** A GraphQL request to the Admin API for `shopId`, refreshed and tried once more on a 401. */
  async graphql<T>(
    shopId: string,
    document: string,
    variables?: Record<string, unknown>,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    return this.#withToken((accessToken) =>
      graphqlRequest<T>(this.fetcher, document, variables, { accessToken, shopId, ...options }),
    );
  }

  async #withToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Signed out');
    try {
      return await call(token);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      const fresh = await this.refresh();
      if (!fresh) throw error;
      return call(fresh.accessToken);
    }
  }

  async #refreshOnce(used: string): Promise<Tokens | null> {
    // Another tab may have refreshed meanwhile: its tokens are the ones to use.
    const kept = this.#read();
    if (kept && kept.refreshToken !== used) {
      this.#set(kept, false);
      return kept;
    }
    try {
      const tokens = await authRequest<Tokens>(this.fetcher, '/auth/refresh', {
        body: { refreshToken: used },
      });
      this.#set(tokens);
      return tokens;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REFRESH_TOKEN_ALREADY_USED') {
        // Used a moment ago, by a tab without the browser's locks: take what it kept.
        const other = this.#read();
        if (other && other.refreshToken !== used) {
          this.#set(other, false);
          return other;
        }
      }
      if (error instanceof ApiError && (error.status === 401 || error.status === 409)) {
        this.#set(null);
        return null;
      }
      throw error;
    }
  }

  /** `run` while no other tab refreshes, where the browser has Web Locks. */
  #exclusively<T>(run: () => Promise<T>): Promise<T> {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return locks ? locks.request('hatti.session.refresh', run) : run();
  }

  #read(): Tokens | null {
    try {
      return parseTokens(this.storage?.getItem(STORAGE_KEY) ?? null);
    } catch {
      return this.#tokens ?? null;
    }
  }

  #set(tokens: Tokens | null, keep = true): void {
    this.#tokens = tokens;
    if (keep) {
      try {
        if (tokens) this.storage?.setItem(STORAGE_KEY, JSON.stringify(tokens));
        else this.storage?.removeItem(STORAGE_KEY);
      } catch {
        // Kept in memory for this visit.
      }
    }
    const next = this.#snapshotOf(tokens);
    if (
      next.signedIn !== this.#snapshot.signedIn ||
      next.mfaVerified !== this.#snapshot.mfaVerified
    ) {
      this.#snapshot = next;
      for (const listener of this.#listeners) listener();
    }
  }

  #snapshotOf(tokens: Tokens | null): SessionSnapshot {
    if (!tokens || Date.parse(tokens.refreshTokenExpiresAt) <= this.now()) return SIGNED_OUT;
    return { signedIn: true, mfaVerified: tokens.session.mfaVerified };
  }
}
