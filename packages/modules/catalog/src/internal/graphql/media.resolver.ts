import { CurrentTenant, PublicSite, type TenantContext } from '@hatti/api';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { imagePathOf, shownSizeOf } from '../images.js';
import type { MediaRecord } from '../records.js';
import { Image, ProductMedia } from './product.types.js';

/** A product's media: its image as Hatti serves it, on the core's public site (ADR-158). */
@Resolver(() => ProductMedia)
export class ProductMediaResolver {
  constructor(private readonly site: PublicSite) {}

  @ResolveField(() => Image, {
    nullable: true,
    description:
      'The image as Hatti serves it, cropped where it is (ADR-257), once ready; null until then.',
  })
  image(@CurrentTenant() tenant: TenantContext, @Parent() media: ProductMedia): Image | null {
    return this.#image(tenant.shopId, media.record, media.handle);
  }

  @ResolveField(() => Image, {
    nullable: true,
    description:
      'The whole image, before any crop, for cropping it again (ADR-257); null until it is ready.',
  })
  wholeImage(@CurrentTenant() tenant: TenantContext, @Parent() media: ProductMedia): Image | null {
    return this.#image(tenant.shopId, { ...media.record, crop: null }, media.handle);
  }

  #image(shopId: string, record: MediaRecord, handle: string): Image | null {
    const path = imagePathOf(shopId, record, handle);
    const size = shownSizeOf(record);
    if (path === null || size === null) return null;
    return Object.assign(new Image(), {
      url: this.site.url(path),
      width: size.width,
      height: size.height,
      altText: record.alt || null,
    });
  }
}
