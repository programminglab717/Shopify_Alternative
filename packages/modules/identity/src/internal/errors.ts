export type AuthErrorCode =
  | 'INVALID_INPUT'
  /** No shop signs its staff in through the email's organisation (ADR-864). */
  | 'SSO_NOT_SET_UP'
  /** The organisation's identity provider can't be reached now. */
  | 'SSO_UNREACHABLE'
  /** The provider's answer was traded already, or too late. */
  | 'SSO_EXPIRED'
  /** A session the shop's provider began reaches that shop alone, not the account's settings. */
  | 'SSO_SESSION'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_TAKEN'
  | 'WEAK_PASSWORD'
  | 'RATE_LIMITED'
  | 'INVALID_CHALLENGE'
  | 'INVALID_CODE'
  | 'INVALID_REFRESH_TOKEN'
  | 'REFRESH_TOKEN_ALREADY_USED'
  | 'SESSION_REVOKED'
  | 'UNAUTHENTICATED'
  | 'MFA_REQUIRED'
  | 'TOTP_NOT_SET_UP'
  | 'NOT_FOUND'
  | 'INVALID_PASSKEY'
  | 'PASSKEY_TAKEN'
  | 'TOO_MANY_PASSKEYS'
  | 'PASSKEYS_UNAVAILABLE'
  | 'INVALID_INVITATION'
  | 'ALREADY_MEMBER'
  | 'REAUTHENTICATION_REQUIRED'
  | 'INVALID_METHOD'
  | 'INVALID_PASSWORD'
  | 'HANDLE_TAKEN'
  | 'TOO_MANY_SHOPS'
  // Hatti's terms changed after the page agreeing to them was shown (ADR-737).
  | 'TERMS_CHANGED'
  // A shop closed, or taken down by Hatti, that the request needs open, or the other way (ADR-740).
  | 'SHOP_NOT_OPEN'
  | 'SHOP_NOT_CLOSED'
  | 'NOT_SUPPORT'
  | 'PHONE_SIGN_IN_UNAVAILABLE'
  | 'CODE_NOT_SENT'
  | 'TOO_SOON'
  | 'TOO_MANY_CODES'
  | 'CODE_EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'INVALID_SIGN_UP'
  | 'PHONE_TAKEN'
  | 'GOOGLE_SIGN_IN_UNAVAILABLE'
  | 'GOOGLE_UNREACHABLE'
  | 'INVALID_GOOGLE_SIGN_IN'
  | 'GOOGLE_EMAIL_UNCONFIRMED'
  | 'GOOGLE_NOT_CONNECTED'
  | 'GOOGLE_TAKEN'
  | 'GOOGLE_CONNECTED'
  | 'ONLY_SIGN_IN_METHOD'
  | 'EMAIL_UNAVAILABLE'
  | 'EMAIL_NOT_SENT'
  | 'EMAIL_UNDELIVERABLE'
  | 'EMAIL_UNCHANGED'
  | 'TOO_MANY_EMAILS'
  | 'NO_EMAIL'
  | 'EMAIL_ALREADY_VERIFIED'
  | 'INVALID_EMAIL_LINK'
  | 'INVALID_REQUEST'
  | 'SHOP_NOT_FOUND'
  | 'TOO_MANY_REQUESTS'
  | 'REQUEST_WAITING'
  | 'NOT_PARTNER'
  // Public apps (ADR-851): too many registered, a member who may not install one, an app not
  // yet listed, and a code, client ID or secret that is not good.
  | 'TOO_MANY_APPS'
  | 'TOO_MANY_THEMES'
  | 'FORBIDDEN'
  | 'NOT_LISTED'
  | 'INVALID_GRANT';

/** An expected failure with an HTTP status and a stable code for clients. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly status: number,
    message: string,
    readonly details: { fields?: Record<string, string>; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const invalidCredentials = () =>
  new AuthError('INVALID_CREDENTIALS', 401, 'Incorrect email or password');

export const unauthenticated = () =>
  new AuthError('UNAUTHENTICATED', 401, 'Sign in again: the access token is invalid or expired');
