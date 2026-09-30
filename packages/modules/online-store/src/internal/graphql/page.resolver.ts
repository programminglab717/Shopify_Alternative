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
import { PageService } from '../page.service.js';
import { toPage, toPageConnection, uuidOf } from './mappers.js';
import {
  OnlineStorePage,
  PageConnection,
  PageCreateInput,
  PageCreatePayload,
  PageDeletePayload,
  PageUpdateInput,
  PageUpdatePayload,
  PagesArgs,
} from './page.types.js';

@Resolver(() => OnlineStorePage)
export class PageResolver {
  constructor(private readonly service: PageService) {}

  @Query(() => PageConnection, { description: "The shop's pages, oldest first." })
  @RequireScopes('read_online_store_pages')
  async pages(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: PagesArgs,
  ): Promise<PageConnection> {
    const after = args.after ? uuidOf('page', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after,
    });
    return toPageConnection(items, hasNextPage);
  }

  @Query(() => OnlineStorePage, { nullable: true })
  @RequireScopes('read_online_store_pages')
  async page(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OnlineStorePage | null> {
    const record = await this.service.get(tenant, uuidOf('page', id));
    return record ? toPage(record) : null;
  }

  @Mutation(() => PageCreatePayload, {
    description:
      'A new page, which the storefront shows a moment later unless it is not published. Its ' +
      'body is cleaned of anything that could run.',
  })
  @RequireScopes('write_online_store_pages')
  async pageCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('page') page: PageCreateInput,
  ): Promise<PageCreatePayload> {
    const result = await this.service.create(tenant, page);
    return Object.assign(new PageCreatePayload(), {
      page: result.ok ? toPage(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(inPage(result.errors)),
    });
  }

  @Mutation(() => PageUpdatePayload, {
    description: 'Changes the fields of a page that are given; the others stay as they are.',
  })
  @RequireScopes('write_online_store_pages')
  async pageUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('page') page: PageUpdateInput,
  ): Promise<PageUpdatePayload> {
    const result = await this.service.update(tenant, uuidOf('page', id), page);
    return Object.assign(new PageUpdatePayload(), {
      page: result.ok ? toPage(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(inPage(result.errors)),
    });
  }

  @Mutation(() => PageDeletePayload, {
    description: 'Deletes a page. Menus linking to it leave the link out from then on.',
  })
  @RequireScopes('write_online_store_pages')
  async pageDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PageDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('page', id));
    return Object.assign(new PageDeletePayload(), {
      deletedPageId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** Errors on the page's fields, where the request has them: under `page`. */
function inPage(errors: readonly FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field.length === 0 || error.field[0] === 'id'
      ? error
      : { ...error, field: ['page', ...error.field] },
  );
}
