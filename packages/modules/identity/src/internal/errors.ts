export type AuthErrorCode =
  | 'INVALID_INPUT'
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
  | 'TOO_MANY_EMAILS'
  | 'NO_EMAIL'
  | 'EMAIL_ALREADY_VERIFIED'
  | 'INVALID_EMAIL_LINK';

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
