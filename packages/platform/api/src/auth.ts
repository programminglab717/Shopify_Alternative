import {
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { GraphQLResolveInfo } from 'graphql';
import {
  accessDenied,
  reauthenticationRequired,
  supportReadOnly,
  unauthenticated,
} from './errors.js';
import type { RequestLoaders } from './loaders.js';
import { mutationsRequiringRecentAuthentication } from './recent-authentication.js';
import { hasScope, recentlyAuthenticated, type AccessScope, type TenantContext } from './tenant.js';

/** Request context passed to resolvers. */
export interface ApiContext {
  tenant?: TenantContext;
  /** Batch loaders for this request; created on first use if the host did not. */
  loaders?: RequestLoaders;
}

const REQUIRED_SCOPES = 'hatti:required-scopes';

/** Declares the access scopes a resolver needs. Checked by {@link ScopesGuard}. */
export const RequireScopes = (...scopes: AccessScope[]) => SetMetadata(REQUIRED_SCOPES, scopes);

function tenantOf(context: ExecutionContext): TenantContext | undefined {
  return GqlExecutionContext.create(context).getContext<ApiContext>().tenant;
}

/** The authenticated tenant. Resolvers take the shop from here, never from arguments. */
export const CurrentTenant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const tenant = tenantOf(context);
  if (!tenant) throw unauthenticated();
  return tenant;
});

/**
 * Enforces {@link RequireScopes} on GraphQL resolvers, and then `RequireRecentAuthentication` on
 * mutations: staff who have not proved who they are lately are refused those (ADR-103). Hatti's
 * support is refused every mutation, however it comes (ADR-156).
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType<string>() !== 'graphql') return true;
    const required =
      this.reflector.getAllAndOverride<AccessScope[] | undefined>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const tenant = tenantOf(context);
    if (!tenant) throw unauthenticated();
    if (tenant.actor.kind === 'support' && mutation(context)) throw supportReadOnly();
    const missing = required.filter((scope) => !hasScope(tenant, scope));
    if (missing.length > 0) throw accessDenied(missing);
    if (sensitive(context) && !recentlyAuthenticated(tenant, new Date())) {
      throw reauthenticationRequired();
    }
    return true;
  }
}

/** Whether the resolver is one of the operation's mutations. */
function mutation(context: ExecutionContext): boolean {
  const info = GqlExecutionContext.create(context).getInfo<GraphQLResolveInfo | undefined>();
  return info?.parentType.name === 'Mutation';
}

/** Whether the resolver is a mutation marked `RequireRecentAuthentication`. */
function sensitive(context: ExecutionContext): boolean {
  const info = GqlExecutionContext.create(context).getInfo<GraphQLResolveInfo | undefined>();
  return (
    info?.parentType.name === 'Mutation' &&
    mutationsRequiringRecentAuthentication().has(info.fieldName)
  );
}
