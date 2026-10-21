// The ID this browser keeps for itself (ADR-179, ADR-681), sent with each request to `/auth` in
// X-Hatti-Device, so that a sign-in from it again is known as its own and tells no one, whatever
// version its browser has reached or address its network gives it.

/** The header the core reads the device from (identity's DEVICE_HEADER). */
export const DEVICE_HEADER = 'x-hatti-device';

const KEY = 'hatti.device';

/** 24 random bytes as base64url: 32 characters, as the core takes 16 to 128 URL-safe ones. */
function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * This browser's ID, made the first time and kept with its data; null where the browser keeps
 * nothing, as a private window may refuse, so that a sign-in is known by its user agent instead,
 * never by an ID each page would make anew.
 */
export function deviceId(): string | null {
  try {
    const kept = window.localStorage.getItem(KEY);
    if (kept && /^[\w-]{16,128}$/.test(kept)) return kept;
    const made = newDeviceId();
    window.localStorage.setItem(KEY, made);
    return window.localStorage.getItem(KEY) === made ? made : null;
  } catch {
    return null;
  }
}
