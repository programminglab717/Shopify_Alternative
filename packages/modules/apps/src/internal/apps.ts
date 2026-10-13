import { randomBytes } from 'node:crypto';
import {
  ACCESS_SCOPES,
  hasScope,
  isAccessScope,
  type InputChecker,
  type TenantContext,
} from '@hatti/api';

/** How many apps a shop keeps at a time, and how long a name may be. */
export const APP_LIMITS = { apps: 20, name: 100 } as const;

/** Distinctive prefix of the secret an app's webhooks are signed with, for secret scanners. */
export const WEBHOOK_SECRET_PREFIX = 'hws_';

export interface GeneratedSecret {
  /** Shown to the shop once; kept sealed. */
  secret: string;
  /** Its last four characters, to tell secrets apart. */
  hint: string;
}

/** A new secret for an app's webhooks: 32 random bytes. */
export function generateWebhookSecret(): GeneratedSecret {
  const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, hint: secret.slice(-4) };
}

/** What an app's sealed secret is bound to: it opens for that shop and app alone. */
export function sealedFor(shopId: string, appId: string): string {
  return `app-webhooks:${shopId}:${appId}`;
}

/**
 * The scopes asked for, known, each once and in the API's order, and none the caller lacks: a
 * member of staff gives an app no more than their own role may do. Null when any is refused.
 */
export function checkScopes(
  check: InputChecker,
  tenant: TenantContext,
  field: string[],
  value: readonly string[],
): string[] | null {
  const asked = new Set(value.map((scope) => scope.trim().toLowerCase()));
  if (asked.size === 0) {
    check.add(field, 'BLANK', 'An app needs at least one scope');
    return null;
  }
  const unknown = [...asked].filter((scope) => !isAccessScope(scope));
  if (unknown.length > 0) {
    check.add(field, 'INVALID', `Unknown scope: ${unknown.join(', ')}`);
    return null;
  }
  const beyond = [...asked].filter((scope) => isAccessScope(scope) && !hasScope(tenant, scope));
  if (beyond.length > 0) {
    check.add(field, 'INVALID', `Your role can't give an app: ${beyond.join(', ')}`);
    return null;
  }
  return ACCESS_SCOPES.filter((scope) => asked.has(scope));
}
