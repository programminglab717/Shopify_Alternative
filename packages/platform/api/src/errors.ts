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

export function badUserInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: ErrorCode.BadUserInput } });
}
