import type { AccessTokenAuthenticator, TenantContext } from '@hatti/api';
import { ErrorCode } from '@hatti/api';
import type { StaffAccessResolver } from '@hatti/identity/public';
import { tryFromPublicId } from '@hatti/ids';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { ACCESS_TOKEN_HEADER, ADMIN_API_PREFIX, SHOP_HEADER } from './constants.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the Admin API authentication hook. */
    tenant?: TenantContext;
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : undefined;
}

async function deny(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  await reply.code(status).send({ errors: [{ message, extensions: { code } }] });
}

/**
 * Authenticates every Admin API request before any GraphQL work. Two kinds of caller:
 *
 * - apps, with an access token in `x-hatti-access-token`, bound to one shop;
 * - staff, with a session access token as `Authorization: Bearer …` plus the shop in
 *   `x-hatti-shop-id`; their role in that shop decides the scopes.
 *
 * Failures never reach a resolver: 401 when the token is not accepted (refresh or sign in
 * again), 400 when the shop is missing, 403 for no access to the shop or a missing second factor.
 */
export function adminApiAuthentication(
  apps: AccessTokenAuthenticator,
  staff: StaffAccessResolver,
): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (!request.url.startsWith(ADMIN_API_PREFIX)) return;

    const appToken = header(request, ACCESS_TOKEN_HEADER);
    if (appToken) {
      const tenant = await apps.authenticate(appToken);
      if (!tenant) {
        await deny(reply, 401, ErrorCode.Unauthenticated, 'Invalid API key or access token');
        return;
      }
      request.tenant = tenant;
      return;
    }

    const staffToken = bearerToken(request);
    if (!staffToken) {
      await deny(
        reply,
        401,
        ErrorCode.Unauthenticated,
        `Send an app access token in ${ACCESS_TOKEN_HEADER}, or a staff access token as ` +
          `"Authorization: Bearer …" with the shop in ${SHOP_HEADER}`,
      );
      return;
    }
    const shopId = tryFromPublicId(header(request, SHOP_HEADER) ?? '', 'shop');
    if (!shopId) {
      await deny(reply, 400, ErrorCode.ShopRequired, `Name the shop in the ${SHOP_HEADER} header`);
      return;
    }
    const result = await staff.resolve(staffToken, shopId);
    if (result.ok) {
      request.tenant = result.tenant;
      return;
    }
    switch (result.reason) {
      case 'unauthenticated':
        await deny(
          reply,
          401,
          ErrorCode.Unauthenticated,
          'The access token is invalid or expired. Refresh it or sign in again',
        );
        return;
      case 'no_shop_access':
        await deny(reply, 403, ErrorCode.NoShopAccess, 'You do not have access to this shop');
        return;
      case 'mfa_required':
        await deny(
          reply,
          403,
          ErrorCode.MfaRequired,
          'Your role in this shop needs two-step verification. Turn it on and sign in again',
        );
        return;
    }
  };
}
