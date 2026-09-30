import {
  CurrentTenant,
  RequireIdempotencyKey,
  RequireScopes,
  UserError,
  decodeCursor,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { PREVIEW_DAYS, ThemePreviewService } from '../theme-preview.js';
import { ThemeService } from '../theme.service.js';
import { toRoleValue, toTheme, toThemeConnection, toThemeFile, uuidOf } from './mappers.js';
import {
  OnlineStoreTheme,
  OnlineStoreThemeConnection,
  OnlineStoreThemeFile,
  OnlineStoreThemeFilesUpsertFileInput,
  ThemeCreatePayload,
  ThemeDeletePayload,
  ThemeFilesDeletePayload,
  ThemeFilesUpsertPayload,
  ThemePublishPayload,
  ThemesArgs,
} from './theme.types.js';

@Resolver(() => OnlineStoreTheme)
export class ThemeResolver {
  constructor(
    private readonly service: ThemeService,
    private readonly previews: ThemePreviewService,
  ) {}

  @Query(() => OnlineStoreThemeConnection, {
    description:
      "The shop's themes: the main one, which the storefront shows, first, then the newest.",
  })
  @RequireScopes('read_themes')
  async themes(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ThemesArgs,
  ): Promise<OnlineStoreThemeConnection> {
    const after = args.after ? uuidOf('theme', decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.list(tenant, {
      first: pageSize(args.first),
      after,
      roles: args.roles?.map(toRoleValue) ?? null,
    });
    return toThemeConnection(items, hasNextPage);
  }

  @Query(() => OnlineStoreTheme, { nullable: true })
  @RequireScopes('read_themes')
  async theme(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<OnlineStoreTheme | null> {
    const record = await this.service.get(tenant, uuidOf('theme', id));
    return record ? toTheme(record) : null;
  }

  @ResolveField(() => [OnlineStoreThemeFile], {
    description:
      "The shop's own files in the theme, by filename: all of them, or those named. The platform " +
      "theme's show where the shop has none.",
  })
  @RequireScopes('read_themes')
  async files(
    @CurrentTenant() tenant: TenantContext,
    @Parent() theme: OnlineStoreTheme,
    @Args('filenames', { type: () => [String], nullable: true }) filenames?: string[] | null,
  ): Promise<OnlineStoreThemeFile[]> {
    const records = await this.service.files(tenant, uuidOf('theme', theme.id), filenames);
    return records.map(toThemeFile);
  }

  @ResolveField(() => String, {
    description:
      'A link to the storefront showing the theme, published or not, for ' +
      `${PREVIEW_DAYS} days: to look at it, or to send for a second opinion. The pages opened ` +
      "from it show the theme, as saved, until the link ends or the preview's bar ends it.",
  })
  @RequireScopes('read_themes')
  async previewUrl(
    @CurrentTenant() tenant: TenantContext,
    @Parent() theme: OnlineStoreTheme,
  ): Promise<string> {
    return (await this.previews.link(tenant, uuidOf('theme', theme.id))).url;
  }

  @Mutation(() => ThemeCreatePayload, {
    description:
      'A new theme to prepare before publishing it: on the platform theme, or a copy of the files ' +
      'of `copyFrom`, such as the main theme.',
  })
  @RequireScopes('write_themes')
  @RequireIdempotencyKey()
  async themeCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('name') name: string,
    @Args('copyFrom', { type: () => ID, nullable: true }) copyFrom?: string | null,
  ): Promise<ThemeCreatePayload> {
    const result = await this.service.create(tenant, {
      name,
      copyFrom: copyFrom ? uuidOf('theme', copyFrom) : null,
    });
    return Object.assign(new ThemeCreatePayload(), {
      theme: result.ok ? toTheme(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ThemePublishPayload, {
    description:
      'Makes the theme the main one, which the storefront shows a moment later; the main one ' +
      'before it is unpublished.',
  })
  @RequireScopes('write_themes')
  async themePublish(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ThemePublishPayload> {
    const result = await this.service.publish(tenant, uuidOf('theme', id));
    return Object.assign(new ThemePublishPayload(), {
      theme: result.ok ? toTheme(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ThemeDeletePayload, { description: 'Deletes a theme other than the main one.' })
  @RequireScopes('write_themes')
  async themeDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ThemeDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('theme', id));
    return Object.assign(new ThemeDeletePayload(), {
      deletedThemeId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ThemeFilesUpsertPayload, {
    description:
      "Saves the shop's own JSON files in a theme: templates, section groups and settings, " +
      'replacing those of the same names; all of them or none. Liquid, assets and translations ' +
      "stay the platform theme's.",
  })
  @RequireScopes('write_themes')
  async themeFilesUpsert(
    @CurrentTenant() tenant: TenantContext,
    @Args('themeId', { type: () => ID }) themeId: string,
    @Args('files', { type: () => [OnlineStoreThemeFilesUpsertFileInput] })
    files: OnlineStoreThemeFilesUpsertFileInput[],
  ): Promise<ThemeFilesUpsertPayload> {
    const result = await this.service.upsertFiles(tenant, uuidOf('theme', themeId), files);
    return Object.assign(new ThemeFilesUpsertPayload(), {
      theme: result.ok ? toTheme(result.value.theme) : null,
      upsertedThemeFiles: result.ok ? result.value.files.map(toThemeFile) : [],
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => ThemeFilesDeletePayload, {
    description: "Deletes the shop's own files from a theme, so the platform theme's show again.",
  })
  @RequireScopes('write_themes')
  async themeFilesDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('themeId', { type: () => ID }) themeId: string,
    @Args('files', { type: () => [String] }) files: string[],
  ): Promise<ThemeFilesDeletePayload> {
    const result = await this.service.deleteFiles(tenant, uuidOf('theme', themeId), files);
    return Object.assign(new ThemeFilesDeletePayload(), {
      theme: result.ok ? toTheme(result.value.theme) : null,
      deletedThemeFiles: result.ok ? result.value.deleted : [],
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
