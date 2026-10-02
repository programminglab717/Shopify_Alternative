import { CurrentTenant, PublicSite, type TenantContext } from '@hatti/api';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { imagePathOf } from '../images.js';
import { Image, ProductMedia } from './product.types.js';

/** A product's media: its image as Hatti serves it, on the core's public site (ADR-158). */
@Resolver(() => ProductMedia)
export class ProductMediaResolver {
  constructor(private readonly site: PublicSite) {}

  @ResolveField(() => Image, {
    nullable: true,
    description: 'The image as Hatti serves it, once ready; null until then.',
  })
  image(@CurrentTenant() tenant: TenantContext, @Parent() media: ProductMedia): Image | null {
    const { record, handle } = media;
    const path = imagePathOf(tenant.shopId, record, handle);
    if (path === null || record.width === null || record.height === null) return null;
    return Object.assign(new Image(), {
      url: this.site.url(path),
      width: record.width,
      height: record.height,
      altText: record.alt || null,
    });
  }
}
