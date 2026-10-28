import { keepSession, sessionOf } from './session';

/** What the console's server refused, as it says it: `{ error: { code, message, fields? } }`. */
export class ConsoleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ConsoleError';
  }
}

/** Told when the session has ended, so the console goes back to signing in. */
let onSignedOut: () => void = () => {};
export const whenSignedOut = (listener: () => void) => {
  onSignedOut = listener;
};

/** A call to the console's server, at `/console/api`, with the tab's session where it has one. */
export async function consoleCall<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const session = sessionOf();
  let response: Response;
  try {
    response = await fetch(`/console/api${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined && { 'content-type': 'application/json' }),
        ...(session && { authorization: `Bearer ${session.token}` }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ConsoleError(0, 'UNREACHABLE', "The console's server can't be reached");
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; fields?: Record<string, string> };
  };
  if (!response.ok) {
    const error = new ConsoleError(
      response.status,
      body.error?.code ?? 'FAILED',
      body.error?.message ?? 'Something went wrong. Try again',
      body.error?.fields ?? {},
    );
    if (error.code === 'CONSOLE_SIGNED_OUT') {
      keepSession(null);
      onSignedOut();
    }
    throw error;
  }
  return body as T;
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Try again';
