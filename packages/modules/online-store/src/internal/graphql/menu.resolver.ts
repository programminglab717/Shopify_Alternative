import {
  CurrentTenant,
  RequireScopes,
  UserError,
  decodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { MenuItemInput } from '../menu-items.js';
import { MenuService } from '../menu.service.js';
import { toMenu, toMenuConnection, uuidOf } from './mappers.js';
import {
  Menu,
  MenuConnection,
  MenuCreatePayload,
  MenuDeletePayload,
  MenuItemCreateInput,
  MenuItemType,
  MenuItemUpdateInput,
  MenuUpdatePayload,
  MenusArgs,
} from './menu.types.js';

@Resolver(() => Menu)
export class MenuResolver {
  constructor(private readonly service: MenuService) {}

  @Query(() => MenuConnection, {
    description:
      "The shop's menus: the main menu and the footer menu first, then the others by title. " +
      'The first time, it makes those two from what the storefront showed until then.',
  })
  @RequireScopes('read_online_store_navigation')
  async menus(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: MenusArgs,
  ): Promise<MenuConnection> {
    const after = args.after ? uuidOf('menu', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after,
    });
    return toMenuConnection(items, hasNextPage);
  }

  @Query(() => Menu, { nullable: true })
  @RequireScopes('read_online_store_navigation')
  async menu(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Menu | null> {
    const record = await this.service.get(tenant, uuidOf('menu', id));
    return record ? toMenu(record) : null;
  }

  @Mutation(() => MenuCreatePayload, {
    description:
      'A new menu, which the storefront publishes a moment later. Its handle names it to themes.',
  })
  @RequireScopes('write_online_store_navigation')
  async menuCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('title') title: string,
    @Args('handle') handle: string,
    @Args('items', { type: () => [MenuItemCreateInput] }) items: MenuItemCreateInput[],
  ): Promise<MenuCreatePayload> {
    const result = await this.service.create(tenant, { title, handle, items: itemInputs(items) });
    return Object.assign(new MenuCreatePayload(), {
      menu: result.ok ? toMenu(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => MenuUpdatePayload, {
    description:
      "Changes a menu: its title, its handle (not the main or footer menu's), and all its items, " +
      'those not given going.',
  })
  @RequireScopes('write_online_store_navigation')
  async menuUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('title') title: string,
    @Args('items', { type: () => [MenuItemUpdateInput] }) items: MenuItemUpdateInput[],
    @Args('handle', { type: () => String, nullable: true }) handle?: string | null,
  ): Promise<MenuUpdatePayload> {
    const result = await this.service.update(tenant, uuidOf('menu', id), {
      title,
      handle,
      items: itemInputs(items),
    });
    return Object.assign(new MenuUpdatePayload(), {
      menu: result.ok ? toMenu(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => MenuDeletePayload, {
    description: 'Deletes a menu other than the main and footer menus, which every shop has.',
  })
  @RequireScopes('write_online_store_navigation')
  async menuDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<MenuDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('menu', id));
    return Object.assign(new MenuDeletePayload(), {
      deletedMenuId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** Items as the service takes them: IDs of this API's kinds turned into the records' own. */
function itemInputs(
  items: readonly (MenuItemCreateInput | MenuItemUpdateInput)[] | null | undefined,
): MenuItemInput[] {
  return (items ?? []).map((item) => ({
    id: 'id' in item && item.id ? uuidOf('menuItem', item.id) : null,
    title: item.title,
    type: item.type.toLowerCase(),
    resourceId: item.resourceId ? resourceIdOf(item.type, item.resourceId) : null,
    url: item.url ?? null,
    tags: item.tags ?? null,
    items: itemInputs(item.items),
  }));
}

/**
 * A link's collection, product, page, blog or article; any other's given as it is, which the
 * service refuses.
 */
function resourceIdOf(type: MenuItemType, id: string): string {
  if (type === MenuItemType.COLLECTION) return uuidOf('collection', id);
  if (type === MenuItemType.PRODUCT) return uuidOf('product', id);
  if (type === MenuItemType.PAGE) return uuidOf('page', id);
  if (type === MenuItemType.BLOG) return uuidOf('blog', id);
  if (type === MenuItemType.ARTICLE) return uuidOf('article', id);
  return id;
}
