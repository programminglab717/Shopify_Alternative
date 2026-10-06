import {
  CurrentTenant,
  RequireScopes,
  UserError,
  badUserInput,
  decodeCursor,
  encodeCursor,
  pageSize,
  PageInfo,
  type TenantContext,
} from '@hatti/api';
import { PublicIdError, parsePublicId, toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  PRIMARY_LOCALE,
  isTranslatableKind,
  type TranslatableKind,
} from '../translation-content.js';
import {
  TranslationService,
  type TranslatableResourceRecord,
  type TranslationRecord,
} from '../translation.service.js';
import { uuidOf } from './mappers.js';
import {
  LocalizableContentType,
  TranslatableContent,
  TranslatableResource,
  TranslatableResourceConnection,
  TranslatableResourceEdge,
  TranslatableResourcesArgs,
  Translation,
  TranslationInput,
  TranslationsRegisterPayload,
  TranslationsRemovePayload,
} from './translation.types.js';

@Resolver(() => TranslatableResource)
export class TranslationResolver {
  constructor(private readonly service: TranslationService) {}

  @Query(() => TranslatableResource, {
    nullable: true,
    description:
      'A product, collection, page, blog, article, menu, menu item or policy of the shop, by its ' +
      'ID, with its fields that may be translated and their translations (ADR-238).',
  })
  @RequireScopes('read_translations')
  async translatableResource(
    @CurrentTenant() tenant: TenantContext,
    @Args('resourceId', { type: () => ID }) resourceId: string,
  ): Promise<TranslatableResource | null> {
    const { kind, id } = resourceOf(resourceId);
    const record = await this.service.resource(tenant, kind, id);
    return record ? toResource(record) : null;
  }

  @Query(() => TranslatableResourceConnection, {
    description: "The shop's resources of a kind that may be translated, the newest first.",
  })
  @RequireScopes('read_translations')
  async translatableResources(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: TranslatableResourcesArgs,
  ): Promise<TranslatableResourceConnection> {
    const kind = args.resourceType as TranslatableKind;
    const after = args.after ? uuidOf(kind, decodeCursor(args.after, ['id']).id) : null;
    const { items, hasNextPage } = await this.service.resources(tenant, kind, {
      first: pageSize(args.first),
      after,
    });
    const nodes = items.map(toResource);
    const edges = nodes.map((node) =>
      Object.assign(new TranslatableResourceEdge(), {
        node,
        cursor: encodeCursor({ id: node.resourceId }),
      }),
    );
    return Object.assign(new TranslatableResourceConnection(), {
      edges,
      nodes,
      pageInfo: Object.assign(new PageInfo(), {
        hasNextPage,
        endCursor: edges.at(-1)?.cursor ?? null,
      }),
    });
  }

  @ResolveField(() => [Translation], {
    description:
      'Its translations into `locale`; with `outdated`, only those whose words have, or have ' +
      'not, changed since.',
  })
  translations(
    @Parent() resource: TranslatableResource,
    @Args('locale') locale: string,
    @Args('outdated', { type: () => Boolean, nullable: true }) outdated?: boolean | null,
  ): Translation[] {
    return resource.kept
      .filter(
        (translation) =>
          translation.locale === locale &&
          (outdated === null || outdated === undefined || translation.outdated === outdated),
      )
      .map(toTranslation);
  }

  @Mutation(() => TranslationsRegisterPayload, {
    description:
      "Keeps translations of a resource's fields, each naming the digest of the words it " +
      "translates, as Shopify's translationsRegister: one kept already for a field in the " +
      "language is replaced, and the storefront's Urdu pages show them a moment later.",
  })
  @RequireScopes('write_translations')
  async translationsRegister(
    @CurrentTenant() tenant: TenantContext,
    @Args('resourceId', { type: () => ID }) resourceId: string,
    @Args('translations', { type: () => [TranslationInput] }) translations: TranslationInput[],
  ): Promise<TranslationsRegisterPayload> {
    const { kind, id } = resourceOf(resourceId);
    const result = await this.service.register(tenant, kind, id, translations);
    return Object.assign(new TranslationsRegisterPayload(), {
      translations: result.ok ? result.value.map(toTranslation) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => TranslationsRemovePayload, {
    description:
      "Forgets a resource's translations of the fields named, in the languages named, as " +
      "Shopify's translationsRemove: the storefront shows the shop's own words for them again.",
  })
  @RequireScopes('write_translations')
  async translationsRemove(
    @CurrentTenant() tenant: TenantContext,
    @Args('resourceId', { type: () => ID }) resourceId: string,
    @Args('translationKeys', { type: () => [String] }) translationKeys: string[],
    @Args('locales', { type: () => [String] }) locales: string[],
  ): Promise<TranslationsRemovePayload> {
    const { kind, id } = resourceOf(resourceId);
    const result = await this.service.remove(tenant, kind, id, translationKeys, locales);
    return Object.assign(new TranslationsRemovePayload(), {
      translations: result.ok ? result.value.map(toTranslation) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** What a resource's ID names: its kind, by its prefix, and its UUID. */
function resourceOf(resourceId: string): { kind: TranslatableKind; id: string } {
  try {
    const { kind, uuid } = parsePublicId(resourceId);
    if (isTranslatableKind(kind)) return { kind, id: uuid };
  } catch (error) {
    if (!(error instanceof PublicIdError)) throw error;
    throw badUserInput(`Invalid resource id: ${resourceId.slice(0, 64)}`);
  }
  throw badUserInput(
    'Not a product, collection, page, blog, article, menu, menu item or policy: ' +
      resourceId.slice(0, 64),
  );
}

function toResource(record: TranslatableResourceRecord): TranslatableResource {
  return Object.assign(new TranslatableResource(), {
    resourceId: toPublicId(record.kind, record.id),
    translatableContent: record.content.map((field) =>
      Object.assign(new TranslatableContent(), {
        key: field.key,
        value: field.value,
        digest: field.digest,
        locale: PRIMARY_LOCALE,
        type: field.type as LocalizableContentType,
      }),
    ),
    kept: record.translations,
  });
}

function toTranslation(record: TranslationRecord): Translation {
  return Object.assign(new Translation(), {
    key: record.key,
    value: record.value,
    locale: record.locale,
    outdated: record.outdated,
    updatedAt: record.updatedAt,
  });
}
