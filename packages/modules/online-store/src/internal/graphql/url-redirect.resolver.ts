import {
  CurrentTenant,
  RequireScopes,
  UserError,
  decodeCursor,
  pageSize,
  type FieldError,
  type TenantContext,
} from '@hatti/api';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UrlRedirectService } from '../url-redirect.service.js';
import { toUrlRedirect, toUrlRedirectConnection, uuidOf } from './mappers.js';
import {
  UrlRedirect,
  UrlRedirectConnection,
  UrlRedirectCreatePayload,
  UrlRedirectDeletePayload,
  UrlRedirectInput,
  UrlRedirectUpdatePayload,
  UrlRedirectsArgs,
} from './url-redirect.types.js';

/** URL redirects, as Shopify's are, with its navigation scopes (ADR-052). */
@Resolver(() => UrlRedirect)
export class UrlRedirectResolver {
  constructor(private readonly service: UrlRedirectService) {}

  @Query(() => UrlRedirectConnection, { description: "The shop's URL redirects, oldest first." })
  @RequireScopes('read_online_store_navigation')
  async urlRedirects(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: UrlRedirectsArgs,
  ): Promise<UrlRedirectConnection> {
    const after = args.after ? uuidOf('urlRedirect', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after,
      query: args.query,
    });
    return toUrlRedirectConnection(items, hasNextPage);
  }

  @Query(() => UrlRedirect, { nullable: true })
  @RequireScopes('read_online_store_navigation')
  async urlRedirect(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<UrlRedirect | null> {
    const record = await this.service.get(tenant, uuidOf('urlRedirect', id));
    return record ? toUrlRedirect(record) : null;
  }

  @Mutation(() => UrlRedirectCreatePayload, {
    description:
      'A redirect from a path the shop has no page at to another address, followed by the ' +
      'storefront a moment later.',
  })
  @RequireScopes('write_online_store_navigation')
  async urlRedirectCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('urlRedirect') urlRedirect: UrlRedirectInput,
  ): Promise<UrlRedirectCreatePayload> {
    const result = await this.service.create(tenant, urlRedirect);
    return Object.assign(new UrlRedirectCreatePayload(), {
      urlRedirect: result.ok ? toUrlRedirect(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(inUrlRedirect(result.errors)),
    });
  }

  @Mutation(() => UrlRedirectUpdatePayload, {
    description: 'Changes the path or target given; the other stays as it is.',
  })
  @RequireScopes('write_online_store_navigation')
  async urlRedirectUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('urlRedirect') urlRedirect: UrlRedirectInput,
  ): Promise<UrlRedirectUpdatePayload> {
    const result = await this.service.update(tenant, uuidOf('urlRedirect', id), urlRedirect);
    return Object.assign(new UrlRedirectUpdatePayload(), {
      urlRedirect: result.ok ? toUrlRedirect(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(inUrlRedirect(result.errors)),
    });
  }

  @Mutation(() => UrlRedirectDeletePayload, {
    description: 'Deletes a redirect: its path answers 404 again.',
  })
  @RequireScopes('write_online_store_navigation')
  async urlRedirectDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<UrlRedirectDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('urlRedirect', id));
    return Object.assign(new UrlRedirectDeletePayload(), {
      deletedUrlRedirectId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** Errors on the redirect's fields, where the request has them: under `urlRedirect`. */
function inUrlRedirect(errors: readonly FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field.length === 0 || error.field[0] === 'id'
      ? error
      : { ...error, field: ['urlRedirect', ...error.field] },
  );
}
