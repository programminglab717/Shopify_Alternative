import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
  failOne,
  hasCapability,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CustomAppService, type CustomAppRecord } from '../custom-apps.service.js';
import {
  CustomApp,
  CustomAppCreatePayload,
  CustomAppDeletePayload,
  CustomAppInput,
  CustomAppSecretRotatePayload,
  CustomAppTokenRotatePayload,
  CustomAppUpdatePayload,
} from './apps.types.js';

/**
 * Only the owner and managers manage the shop's apps, and custom roles of managers' that keep it
 * (ADR-578); apps manage none, themselves included.
 */
function managesApps(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff') {
    throw deniedToRole("Access denied. A shop's apps are managed by its owner and managers.");
  }
  if (!hasCapability(tenant.actor, 'manage_apps')) {
    throw deniedToRole('Access denied. Only the owner and managers manage apps.');
  }
}

const NOT_FOUND = 'No app of the shop has this ID';

@Resolver()
export class CustomAppResolver {
  constructor(private readonly service: CustomAppService) {}

  @Query(() => [CustomApp], {
    description: "The shop's custom apps, the latest first (DEV-04, ADR-395).",
  })
  @RequireScopes('read_settings')
  async customApps(@CurrentTenant() tenant: TenantContext): Promise<CustomApp[]> {
    managesApps(tenant);
    return (await this.service.list(tenant)).map(toCustomApp);
  }

  @Mutation(() => CustomAppCreatePayload, {
    description:
      'Makes a custom app with a name and the scopes it may use, none your role lacks: its ' +
      'access token and the secret its webhooks are signed with are given this once.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async customAppCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: CustomAppInput,
  ): Promise<CustomAppCreatePayload> {
    managesApps(tenant);
    const result = await this.service.create(tenant, input);
    return Object.assign(new CustomAppCreatePayload(), {
      customApp: result.ok ? toCustomApp(result.value.app) : null,
      accessToken: result.ok ? result.value.accessToken : null,
      webhookSecret: result.ok ? result.value.webhookSecret : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => CustomAppUpdatePayload, {
    description: 'Renames an app or changes its scopes, from its next request on.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async customAppUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: CustomAppInput,
  ): Promise<CustomAppUpdatePayload> {
    managesApps(tenant);
    const result = await withApp(id, (appId) => this.service.update(tenant, appId, input));
    return Object.assign(new CustomAppUpdatePayload(), {
      customApp: result.ok ? toCustomApp(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => CustomAppTokenRotatePayload, {
    description: 'Gives an app a new access token, shown this once: the one it had stops working.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async customAppTokenRotate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CustomAppTokenRotatePayload> {
    managesApps(tenant);
    const result = await withApp(id, (appId) => this.service.rotateToken(tenant, appId));
    return Object.assign(new CustomAppTokenRotatePayload(), {
      customApp: result.ok ? toCustomApp(result.value.app) : null,
      accessToken: result.ok ? result.value.accessToken : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => CustomAppSecretRotatePayload, {
    description:
      'Gives an app a new secret for its webhooks, shown this once: they are signed with it ' +
      'from now on.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async customAppSecretRotate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CustomAppSecretRotatePayload> {
    managesApps(tenant);
    const result = await withApp(id, (appId) => this.service.rotateSecret(tenant, appId));
    return Object.assign(new CustomAppSecretRotatePayload(), {
      customApp: result.ok ? toCustomApp(result.value.app) : null,
      webhookSecret: result.ok ? result.value.webhookSecret : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => CustomAppDeletePayload, {
    description: 'Removes an app: its access token stops working at once.',
  })
  @RequireScopes('write_settings')
  async customAppDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CustomAppDeletePayload> {
    managesApps(tenant);
    const result = await withApp(id, (appId) => this.service.delete(tenant, appId));
    return Object.assign(new CustomAppDeletePayload(), {
      deletedCustomAppId: result.ok ? toPublicId('accessToken', result.value.id) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

async function withApp<T>(
  id: string,
  fn: (appId: string) => Promise<MutationResult<T>>,
): Promise<MutationResult<T>> {
  const appId = tryFromPublicId(id, 'accessToken');
  return appId ? fn(appId) : failOne(['id'], 'NOT_FOUND', NOT_FOUND);
}

function toCustomApp(record: CustomAppRecord): CustomApp {
  return Object.assign(new CustomApp(), {
    id: toPublicId('accessToken', record.id),
    name: record.name,
    scopes: record.scopes,
    tokenHint: record.tokenHint,
    secretHint: record.secretHint,
    createdById: record.createdBy && toPublicId('user', record.createdBy),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
