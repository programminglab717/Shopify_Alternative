import { CurrentTenant, PublicSite, type TenantContext } from '@hatti/api';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { imagePathOf, shownSizeOf } from '../images.js';
import type { MediaRecord } from '../records.js';
import { videoPathOf } from '../videos.js';
import { Image, ProductMedia, ProductVideo, VideoSource } from './product.types.js';

/**
 * A product's media: its image as Hatti serves it, on the core's public site (ADR-158), and a
 * video's file (ADR-258).
 */
@Resolver(() => ProductMedia)
export class ProductMediaResolver {
  constructor(private readonly site: PublicSite) {}

  @ResolveField(() => Image, {
    nullable: true,
    description:
      'The image as Hatti serves it, cropped where it is (ADR-257), once ready; null until then, ' +
      'and for a video, whose is its previewImage.',
  })
  image(@CurrentTenant() tenant: TenantContext, @Parent() media: ProductMedia): Image | null {
    const { record } = media;
    return record.mediaType === 'image' ? this.#image(tenant.shopId, record, media.handle) : null;
  }

  @ResolveField(() => Image, {
    nullable: true,
    description:
      'The whole image, before any crop, for cropping it again (ADR-257); null until it is ready, ' +
      'and for a video.',
  })
  wholeImage(@CurrentTenant() tenant: TenantContext, @Parent() media: ProductMedia): Image | null {
    const { record } = media;
    return record.mediaType === 'image'
      ? this.#image(tenant.shopId, { ...record, crop: null }, media.handle)
      : null;
  }

  @ResolveField(() => Image, {
    nullable: true,
    description:
      "What shows of it before anything plays, as Shopify's preview image: an image itself, as " +
      "shown, or a video's preview image (ADR-258); null until it is ready.",
  })
  previewImage(
    @CurrentTenant() tenant: TenantContext,
    @Parent() media: ProductMedia,
  ): Image | null {
    return this.#image(tenant.shopId, media.record, media.handle);
  }

  @ResolveField(() => ProductVideo, {
    nullable: true,
    description:
      'A video the shop uploaded, as Hatti serves it once ready; null for anything else.',
  })
  video(
    @CurrentTenant() tenant: TenantContext,
    @Parent() media: ProductMedia,
  ): ProductVideo | null {
    const { record } = media;
    const path = videoPathOf(tenant.shopId, record, media.handle);
    if (path === null || record.video === null) return null;
    return Object.assign(new ProductVideo(), {
      sources: [
        Object.assign(new VideoSource(), {
          url: this.site.url(path),
          mimeType: 'video/mp4',
          format: 'mp4',
          width: record.video.width,
          height: record.video.height,
          fileSize: record.video.size,
        }),
      ],
      duration: record.video.durationMs,
    });
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
