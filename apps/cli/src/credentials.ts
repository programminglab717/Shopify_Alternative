import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Where `hatti login` keeps what it was given (ADR-990): one file, readable by its owner alone,
// holding a login for each shop signed in to and which one commands use. As the GitHub and
// Shopify command lines keep theirs; HATTI_ACCESS_TOKEN, where set, is used instead.

/** A shop's login, as `hatti login` was given it. */
export interface ShopLogin {
  apiUrl: string;
  accessToken: string;
  shopId: string;
  shopName: string;
  shopHandle: string;
  scopes: string[];
  /** The name the terminal gave itself, as the shop's apps list it. */
  device: string;
  createdAt: string;
}

export interface Credentials {
  version: 1;
  /** The handle of the shop commands use unless told: the last signed in to. */
  current: string | null;
  logins: Record<string, ShopLogin>;
}

const EMPTY: Credentials = { version: 1, current: null, logins: {} };

/** The file, in HATTI_CONFIG_DIR, else the platform's place for a user's settings. */
export function credentialsPath(env: Readonly<Record<string, string | undefined>>): string {
  if (env.HATTI_CONFIG_DIR) return join(env.HATTI_CONFIG_DIR, 'credentials.json');
  const base =
    process.platform === 'win32'
      ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'hatti', 'credentials.json');
}

export async function readCredentials(path: string): Promise<Credentials> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (!text) return structuredClone(EMPTY);
  try {
    const kept = JSON.parse(text) as Partial<Credentials>;
    if (kept.version !== 1 || typeof kept.logins !== 'object' || kept.logins === null) {
      return structuredClone(EMPTY);
    }
    return { version: 1, current: kept.current ?? null, logins: kept.logins };
  } catch {
    return structuredClone(EMPTY);
  }
}

/** Written whole, then moved into place, readable by its owner alone. */
export async function writeCredentials(path: string, credentials: Credentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.${process.pid}.tmp`;
  await writeFile(next, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(next, 0o600);
  await rename(next, path);
}

/** The login commands use: `shop`'s where named, else the current one; null for none. */
export function loginOf(credentials: Credentials, shop?: string | null): ShopLogin | null {
  const handle = shop ?? credentials.current;
  return handle ? (credentials.logins[handle] ?? null) : null;
}
