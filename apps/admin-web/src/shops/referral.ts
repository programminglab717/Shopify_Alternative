// A partner's referral link (PRT-02, ADR-505): /sign-up?ref=k7mq2xpa. The code is kept in the
// browser from the page the link opens until the shop is opened, which takes it, across the
// sign-up and an email's link, so that the store is the partner's.

const KEY = 'hatti.referral';
const CODE = /^[a-z0-9]{8}$/;

/** Keeps the `ref` the address names, if it is one. */
export function rememberReferral(search: string = window.location.search): void {
  const code = new URLSearchParams(search).get('ref')?.trim().toLowerCase();
  if (!code || !CODE.test(code)) return;
  try {
    window.localStorage.setItem(KEY, code);
  } catch {
    // Storage refused, as in a private window: the store is no partner's.
  }
}

/** The code kept, if any. */
export function referralCode(): string | null {
  try {
    const code = window.localStorage.getItem(KEY);
    return code && CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** Forgets the code, once a shop has taken it. */
export function forgetReferral(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}
