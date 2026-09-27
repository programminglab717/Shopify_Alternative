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
  | 'NOT_FOUND';

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
