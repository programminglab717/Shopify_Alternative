// The console's session (ADR-876), kept in this tab alone: closing it signs the agent out here,
// and no other tab or window has it. The state of a sign-in begun here is kept beside it, so only
// the provider's answer to this tab's own sign-in is taken.

const SESSION_KEY = 'hatti.console.session';
const STATE_KEY = 'hatti.console.state';

export interface ConsoleAgent {
  email: string;
  name: string;
  /** When the session ends, signed in or not: the end of a working day. */
  expiresAt: string;
}

export interface ConsoleSession {
  token: string;
  agent: ConsoleAgent;
}

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // A tab that keeps nothing signs in again on each page.
  }
}

export function sessionOf(): ConsoleSession | null {
  const kept = read(SESSION_KEY);
  if (!kept) return null;
  try {
    const session = JSON.parse(kept) as ConsoleSession;
    return new Date(session.agent.expiresAt).getTime() > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export const keepSession = (session: ConsoleSession | null) =>
  write(SESSION_KEY, session && JSON.stringify(session));

export const signInStateOf = () => read(STATE_KEY);
export const keepSignInState = (state: string | null) => write(STATE_KEY, state);
