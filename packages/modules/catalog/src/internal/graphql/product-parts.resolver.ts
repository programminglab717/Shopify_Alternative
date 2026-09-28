import { CurrentTenant, RequireScopes, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import type { MutationResult } from '../input-checker.js';
import { MediaService } from '../media.service.js';
import { OptionService } from '../option.service.js';
import type { ProductRecord } from '../records.js';
import { VariantService } from '../variant.service.js';
import { optionalUuidOf, toProduct, toUserErrors, uuidOf } from './mappers.js';
import {
  CreateMediaInput,
  MoveInput,
  ProductCreateMediaPayload,
  ProductDeleteMediaPayload,
  ProductOptionInput,
  ProductOptionUpdateInput,
  ProductOptionValueUpdateInput,
  ProductOptionsDeletePayload,
  ProductPayload,
  ProductVariantsBulkInput,
  ProductVariantsBulkPayload,
  ProductVariantsBulkUpdateInput,
  ProductVariantsStrategy,
  UpdateMediaInput,
  type Product,
} from './product.types.js';

function productPayload(
  result: MutationResult<ProductRecord>,
  tenant: TenantContext,
): ProductPayload {
  return Object.assign(new ProductPayload(), {
    product: result.ok ? toProduct(result.value, tenant.currency) : null,
    userErrors: result.ok ? [] : toUserErrors(result.errors),
  });
}

/** The variants of `product` with the given ids, in that order. */
function pick(product: Product, ids: string[]) {
  const byId = new Map(product.variants.map((variant) => [variant.id, variant]));
  return ids.map((id) => byId.get(toPublicId('variant', id))!);
}

/** Options, variants and media of a product. Every change bumps the product's version. */
@Resolver()
export class ProductPartsResolver {
  constructor(
    private readonly options: OptionService,
    private readonly variants: VariantService,
    private readonly media: MediaService,
  ) {}

  @Mutation(() => ProductPayload, {
    description:
      "Adds up to 3 options in all. Existing variants take each new option's first value.",
  })
  @RequireScopes('write_products')
  async productOptionsCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('options', { type: () => [ProductOptionInput] }) options: ProductOptionInput[],
    @Args('variantStrategy', {
      type: () => ProductVariantsStrategy,
      defaultValue: ProductVariantsStrategy.LEAVE_AS_IS,
    })
    variantStrategy: ProductVariantsStrategy,
  ): Promise<ProductPayload> {
    const result = await this.options.create(
      tenant,
      uuidOf('product', productId),
      options,
      variantStrategy === ProductVariantsStrategy.CREATE ? 'create' : 'leave_as_is',
    );
    return productPayload(result, tenant);
  }

  @Mutation(() => ProductPayload, {
    description:
      'Renames or moves an option, and adds, renames or deletes its values. Values that ' +
      'variants use cannot be deleted.',
  })
  @RequireScopes('write_products')
  async productOptionUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('option') option: ProductOptionUpdateInput,
    @Args('optionValuesToAdd', { type: () => [String], nullable: true })
    optionValuesToAdd: string[] | null,
    @Args('optionValuesToUpdate', { type: () => [ProductOptionValueUpdateInput], nullable: true })
    optionValuesToUpdate: ProductOptionValueUpdateInput[] | null,
    @Args('optionValuesToDelete', { type: () => [ID], nullable: true })
    optionValuesToDelete: string[] | null,
  ): Promise<ProductPayload> {
    const result = await this.options.update(tenant, uuidOf('product', productId), {
      optionId: uuidOf('productOption', option.id),
      name: option.name,
      position: option.position,
      valuesToAdd: optionValuesToAdd,
      valuesToRename: optionValuesToUpdate?.map((value) => ({
        id: uuidOf('productOptionValue', value.id),
        name: value.name,
      })),
      valuesToDelete: optionValuesToDelete?.map((id) => uuidOf('productOptionValue', id)),
    });
    return productPayload(result, tenant);
  }

  @Mutation(() => ProductOptionsDeletePayload, {
    description: 'Deletes options, unless variants would then have the same options.',
  })
  @RequireScopes('write_products')
  async productOptionsDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('options', { type: () => [ID] }) options: string[],
  ): Promise<ProductOptionsDeletePayload> {
    const result = await this.options.delete(
      tenant,
      uuidOf('product', productId),
      options.map((id) => uuidOf('productOption', id)),
    );
    return Object.assign(new ProductOptionsDeletePayload(), {
      deletedOptionsIds: result.ok
        ? result.value.deletedIds.map((id) => toPublicId('productOption', id))
        : null,
      product: result.ok ? toProduct(result.value.product, tenant.currency) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductVariantsBulkPayload, {
    description: 'Adds variants. Option values the product lacks are added to its options.',
  })
  @RequireScopes('write_products')
  async productVariantsBulkCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('variants', { type: () => [ProductVariantsBulkInput] })
    variants: ProductVariantsBulkInput[],
  ): Promise<ProductVariantsBulkPayload> {
    const result = await this.variants.bulkCreate(
      tenant,
      uuidOf('product', productId),
      variants.map((variant) => ({
        ...variant,
        mediaId: optionalUuidOf('media', variant.mediaId),
      })),
    );
    const product = result.ok ? toProduct(result.value.product, tenant.currency) : null;
    return Object.assign(new ProductVariantsBulkPayload(), {
      product,
      productVariants: result.ok && product ? pick(product, result.value.variantIds) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductVariantsBulkPayload, {
    description: 'Changes variants in one go; two variants may swap option values.',
  })
  @RequireScopes('write_products')
  async productVariantsBulkUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('variants', { type: () => [ProductVariantsBulkUpdateInput] })
    variants: ProductVariantsBulkUpdateInput[],
  ): Promise<ProductVariantsBulkPayload> {
    const result = await this.variants.bulkUpdate(
      tenant,
      uuidOf('product', productId),
      variants.map((variant) => ({
        ...variant,
        id: uuidOf('variant', variant.id),
        mediaId: optionalUuidOf('media', variant.mediaId),
      })),
    );
    const product = result.ok ? toProduct(result.value.product, tenant.currency) : null;
    return Object.assign(new ProductVariantsBulkPayload(), {
      product,
      productVariants: result.ok && product ? pick(product, result.value.variantIds) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductPayload, { description: 'Deletes variants; at least one must remain.' })
  @RequireScopes('write_products')
  async productVariantsBulkDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('variantsIds', { type: () => [ID] }) variantsIds: string[],
  ): Promise<ProductPayload> {
    const result = await this.variants.bulkDelete(
      tenant,
      uuidOf('product', productId),
      variantsIds.map((id) => uuidOf('variant', id)),
    );
    return productPayload(result, tenant);
  }

  @Mutation(() => ProductCreateMediaPayload, {
    description: 'Adds images by URL, after the existing ones.',
  })
  @RequireScopes('write_products')
  async productCreateMedia(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('media', { type: () => [CreateMediaInput] }) media: CreateMediaInput[],
  ): Promise<ProductCreateMediaPayload> {
    const result = await this.media.create(tenant, uuidOf('product', productId), media);
    const product = result.ok ? toProduct(result.value.product, tenant.currency) : null;
    const byId = new Map(product?.media.map((item) => [item.id, item]));
    return Object.assign(new ProductCreateMediaPayload(), {
      media: result.ok
        ? result.value.mediaIds.map((id) => byId.get(toPublicId('media', id))!)
        : null,
      product,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductPayload)
  @RequireScopes('write_products')
  async productUpdateMedia(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('media', { type: () => [UpdateMediaInput] }) media: UpdateMediaInput[],
  ): Promise<ProductPayload> {
    const result = await this.media.update(
      tenant,
      uuidOf('product', productId),
      media.map((item) => ({ ...item, id: uuidOf('media', item.id) })),
    );
    return productPayload(result, tenant);
  }

  @Mutation(() => ProductDeleteMediaPayload, {
    description: 'Deletes media; variants that showed them show none.',
  })
  @RequireScopes('write_products')
  async productDeleteMedia(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('mediaIds', { type: () => [ID] }) mediaIds: string[],
  ): Promise<ProductDeleteMediaPayload> {
    const result = await this.media.delete(
      tenant,
      uuidOf('product', productId),
      mediaIds.map((id) => uuidOf('media', id)),
    );
    return Object.assign(new ProductDeleteMediaPayload(), {
      deletedMediaIds: result.ok
        ? result.value.deletedIds.map((id) => toPublicId('media', id))
        : null,
      product: result.ok ? toProduct(result.value.product, tenant.currency) : null,
      userErrors: result.ok ? [] : toUserErrors(result.errors),
    });
  }

  @Mutation(() => ProductPayload, { description: 'Moves media, one move after another.' })
  @RequireScopes('write_products')
  async productReorderMedia(
    @CurrentTenant() tenant: TenantContext,
    @Args('productId', { type: () => ID }) productId: string,
    @Args('moves', { type: () => [MoveInput] }) moves: MoveInput[],
  ): Promise<ProductPayload> {
    const result = await this.media.reorder(
      tenant,
      uuidOf('product', productId),
      moves.map((move) => ({ id: uuidOf('media', move.id), newPosition: move.newPosition })),
    );
    return productPayload(result, tenant);
  }
}
