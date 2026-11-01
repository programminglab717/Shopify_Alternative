import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { HattiAdminApiError, HattiAdminClient } from '@hatti/admin-client';
import type { ShopLogin } from './credentials.js';

// `hatti login` (DEV-08, ADR-990): the terminal asks Hatti for a login, shows its code and opens
// the admin's page for it; the shop's owner or a manager checks the code and lets it in, read-only
// or to change things too; the terminal asks every few seconds until it is given its token, once.
// No password or code of the person's passes through the terminal.

export interface Out {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** The login could not be had; its message says why. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

export type LoginAccess = 'read' | 'write';

export interface LoginOptions {
  apiUrl: string;
  access: LoginAccess;
  /** The name the shop's apps list the terminal by: the computer's, unless given. */
  device?: string;
  out: Out;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Opens the approval page; nothing where null, as --no-browser asks. */
  openBrowser?: ((url: string) => void) | null;
}

interface Begun {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The API's origin, over https unless on this machine. */
export function apiOriginOf(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new LoginError(`Not an address: ${apiUrl}`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new LoginError('Hatti is asked over https');
  }
  return url.origin;
}

/** Opens `url` in the person's browser, as the platform does; quietly nothing where it can't. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The link is printed: it is opened by hand.
  }
}

async function post(
  fetcher: typeof fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new LoginError(
      `Hatti could not be reached at ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/** Signs the terminal in to the shop its person approves: the login to keep. */
export async function login(options: LoginOptions): Promise<ShopLogin> {
  const origin = apiOriginOf(options.apiUrl);
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? delay;
  const device = options.device ?? hostname();
  const begun = await post(fetcher, `${origin}/cli/login`, { device, access: options.access });
  if (begun.status !== 200) {
    throw new LoginError(
      String(begun.json.error_description ?? `Hatti answered ${begun.status} to the login`),
    );
  }
  const asked = begun.json as unknown as Begun;
  const { out } = options;
  out.log(`Your code: ${asked.user_code}`);
  out.log('');
  out.log('Open this page, signed in to Hatti as the shop’s owner or a manager, and check it');
  out.log('shows the same code before you let the terminal in:');
  out.log(`  ${asked.verification_uri_complete}`);
  out.log('');
  out.log('Waiting for it to be approved (Ctrl+C to stop)…');
  if (options.openBrowser !== null)
    (options.openBrowser ?? openInBrowser)(asked.verification_uri_complete);

  let interval = Math.max(1, asked.interval) * 1000;
  const until = Date.now() + asked.expires_in * 1000;
  for (;;) {
    await sleep(interval);
    if (Date.now() > until) {
      throw new LoginError('The login took too long: run hatti login again');
    }
    const answer = await post(fetcher, `${origin}/cli/login/token`, {
      device_code: asked.device_code,
    });
    if (answer.status === 200) {
      return await describe(origin, String(answer.json.access_token), device, fetcher);
    }
    switch (answer.json.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5_000;
        continue;
      case 'access_denied':
        throw new LoginError('The login was refused in the admin');
      case 'expired_token':
        throw new LoginError('The login took too long, or was used already: run hatti login again');
      default:
        throw new LoginError(
          String(answer.json.error_description ?? `Hatti answered ${answer.status}`),
        );
    }
  }
}

/** The shop and scopes a token is for, as the Admin API says. */
async function describe(
  apiUrl: string,
  accessToken: string,
  device: string,
  fetcher: typeof fetch,
): Promise<ShopLogin> {
  const client = new HattiAdminClient({ apiUrl, accessToken, fetch: fetcher });
  try {
    const { data } = await client.request<{
      shop: { id: string; name: string; handle: string };
      accessScopes: string[];
    }>('{ shop { id name handle } accessScopes }');
    return {
      apiUrl,
      accessToken,
      shopId: data.shop.id,
      shopName: data.shop.name,
      shopHandle: data.shop.handle,
      scopes: data.accessScopes,
      device,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof HattiAdminApiError) throw new LoginError(error.message);
    throw error;
  }
}

/** `hatti logout`: the token gives itself up, so it works nowhere; whether Hatti said it did. */
export async function revoke(loginToEnd: ShopLogin, fetcher?: typeof fetch): Promise<boolean> {
  const client = new HattiAdminClient({
    apiUrl: loginToEnd.apiUrl,
    accessToken: loginToEnd.accessToken,
    ...(fetcher && { fetch: fetcher }),
    retries: 1,
  });
  try {
    const { data } = await client.request<{
      accessTokenRevoke: { deletedCustomAppId: string | null };
    }>('mutation { accessTokenRevoke { deletedCustomAppId userErrors { message } } }');
    return data.accessTokenRevoke.deletedCustomAppId !== null;
  } catch {
    return false;
  }
}
