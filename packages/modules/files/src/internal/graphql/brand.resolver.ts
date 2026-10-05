import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { BrandService, type BrandRecord } from '../brand.service.js';
import { FileService } from '../file.service.js';
import { toFile, uuidOf } from './file.resolver.js';
import { ShopBrand, ShopBrandInput, ShopBrandUpdatePayload } from './file.types.js';

/** The shop's brand (ADR-081); the host's Shop type shows it as `brand`. */
@Resolver(() => ShopBrand)
export class BrandResolver {
  constructor(
    private readonly brands: BrandService,
    private readonly files: FileService,
  ) {}

  @Mutation(() => ShopBrandUpdatePayload, {
    description:
      "Sets the shop's logo, one of its files, which its checkout's page shows in place of its " +
      'name, or its square logo, which its link page shows; or takes either away.',
  })
  @RequireScopes('write_files')
  async shopBrandUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ShopBrandInput,
  ): Promise<ShopBrandUpdatePayload> {
    const result = await this.brands.update(tenant, {
      ...(input.logo !== undefined && { logo: input.logo === null ? null : uuidOf(input.logo) }),
      ...(input.squareLogo !== undefined && {
        squareLogo: input.squareLogo === null ? null : uuidOf(input.squareLogo),
      }),
    });
    return Object.assign(new ShopBrandUpdatePayload(), {
      brand: result.ok ? toShopBrand(result.value, this.files) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** The shop's brand as the Admin API shows it, its logos with URLs that show them for an hour. */
export function toShopBrand(record: BrandRecord, files: FileService): ShopBrand {
  return Object.assign(new ShopBrand(), {
    logo: record.logo && toFile(record.logo, files),
    squareLogo: record.squareLogo && toFile(record.squareLogo, files),
    updatedAt: record.updatedAt,
  });
}
