import { GraphQLError } from 'graphql';

/** Machine-readable codes in `extensions.code`. */
export const ErrorCode = {
  Unauthenticated: 'UNAUTHENTICATED',
  AccessDenied: 'ACCESS_DENIED',
  BadUserInput: 'BAD_USER_INPUT',
  InternalServerError: 'INTERNAL_SERVER_ERROR',
  /** A staff request did not say which shop it is for. */
  ShopRequired: 'SHOP_REQUIRED',
  /** The staff member has no active role in that shop. */
  NoShopAccess: 'NO_SHOP_ACCESS',
  /** The role needs two-step verification and the session has not passed it. */
  MfaRequired: 'MFA_REQUIRED',
  /**
   * A sensitive action from staff who have not proved who they are lately: they re-authenticate
   * (`POST /auth/reauthenticate`) and try again.
   */
  ReauthenticationRequired: 'REAUTHENTICATION_REQUIRED',
  /** A mutation that is not safe to repeat came without an Idempotency-Key header. */
  IdempotencyKeyRequired: 'IDEMPOTENCY_KEY_REQUIRED',
  /** The Idempotency-Key header is not 1 to 255 visible ASCII characters. */
  IdempotencyKeyInvalid: 'IDEMPOTENCY_KEY_INVALID',
  /** The key came before with a different request. */
  IdempotencyKeyReused: 'IDEMPOTENCY_KEY_REUSED',
  /** The first request with the key is still running. */
  IdempotencyKeyInUse: 'IDEMPOTENCY_KEY_IN_USE',
  /** Hatti's support looks at a shop and changes nothing in it (ADR-156). */
  SupportReadOnly: 'SUPPORT_READ_ONLY',
} as const;

export function unauthenticated(): GraphQLError {
  return new GraphQLError('Invalid API key or access token', {
    extensions: { code: ErrorCode.Unauthenticated },
  });
}

export function accessDenied(required: readonly string[]): GraphQLError {
  const scopes = required.map((scope) => `\`${scope}\``).join(', ');
  return new GraphQLError(`Access denied. Required access: ${scopes} access scope.`, {
    extensions: { code: ErrorCode.AccessDenied, requiredAccess: required },
  });
}

/** Denied by the caller's role rather than a scope, e.g. a packer revealing a number. */
export function deniedToRole(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: ErrorCode.AccessDenied } });
}

/** The message staff get when a sensitive action needs them to prove who they are first. */
export const REAUTHENTICATION_MESSAGE =
  'Confirm it is you first, with your password, a passkey or your authenticator app, then try ' +
  'again';

/** What Hatti's support is told when it asks for anything but one query (ADR-156). */
export const SUPPORT_READ_ONLY_MESSAGE =
  "Hatti's support only looks: it changes nothing in a shop, and asks one query at a time";

/** Anything but a query from Hatti's support (ADR-156). */
export function supportReadOnly(): GraphQLError {
  return new GraphQLError(SUPPORT_READ_ONLY_MESSAGE, {
    extensions: { code: ErrorCode.SupportReadOnly },
  });
}

/** A sensitive action from staff who have not proved who they are lately (ADR-103). */
export function reauthenticationRequired(): GraphQLError {
  return new GraphQLError(REAUTHENTICATION_MESSAGE, {
    extensions: { code: ErrorCode.ReauthenticationRequired },
  });
}

export function badUserInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: ErrorCode.BadUserInput } });
}
