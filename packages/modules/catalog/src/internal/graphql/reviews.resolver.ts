import {
  CurrentTenant,
  RequireScopes,
  UserError,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ProductReviewService, type ProductReviewRecord } from '../review.service.js';
import type { ReviewStatusValue } from '../reviews.js';
import {
  ProductReview,
  ProductReviewPayload,
  ProductReviewStatus,
  ReviewSettings,
  ReviewSettingsInput,
  ReviewSettingsPayload,
} from './reviews.types.js';

const NOT_FOUND = 'No review of the shop has this ID';

function toReview(record: ProductReviewRecord): ProductReview {
  return Object.assign(new ProductReview(), {
    ...record,
    id: toPublicId('productReview', record.id),
    productId: toPublicId('product', record.productId),
    orderId: toPublicId('order', record.orderId),
    status: record.status.toUpperCase() as ProductReviewStatus,
  });
}

function payload(result: MutationResult<ProductReviewRecord>): ProductReviewPayload {
  return Object.assign(new ProductReviewPayload(), {
    productReview: result.ok ? toReview(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });
}

/** Products' reviews (MKT-05, ADR-399): read and moderated as products are. */
@Resolver()
export class ProductReviewResolver {
  constructor(private readonly service: ProductReviewService) {}

  @Query(() => [ProductReview], {
    description:
      "The shop's products' reviews, the latest first: those of a status or a product if given; " +
      '`first` of them (50 unless given, 250 at most), older than the review `after` names.',
  })
  @RequireScopes('read_products')
  async productReviews(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
    @Args('after', { type: () => ID, nullable: true }) after?: string | null,
    @Args('status', { type: () => ProductReviewStatus, nullable: true })
    status?: ProductReviewStatus | null,
    @Args('productId', { type: () => ID, nullable: true }) productId?: string | null,
  ): Promise<ProductReview[]> {
    const afterId = after ? tryFromPublicId(after, 'productReview') : null;
    const product = productId ? tryFromPublicId(productId, 'product') : null;
    if ((after && !afterId) || (productId && !product)) return [];
    const records = await this.service.list(tenant, {
      first: first ?? undefined,
      after: afterId,
      status: status ? (status.toLowerCase() as ReviewStatusValue) : null,
      productId: product,
    });
    return records.map(toReview);
  }

  @Mutation(() => ProductReviewPayload, {
    description: "Shows a review on its product's storefront page.",
  })
  @RequireScopes('write_products')
  async productReviewPublish(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ProductReviewPayload> {
    return this.moderate(tenant, id, 'published');
  }

  @Mutation(() => ProductReviewPayload, {
    description: 'Keeps a review off the storefront. It can be published again.',
  })
  @RequireScopes('write_products')
  async productReviewHide(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ProductReviewPayload> {
    return this.moderate(tenant, id, 'hidden');
  }

  @Query(() => ReviewSettings)
  @RequireScopes('read_settings')
  async reviewSettings(@CurrentTenant() tenant: TenantContext): Promise<ReviewSettings> {
    return Object.assign(new ReviewSettings(), await this.service.settings(tenant));
  }

  @Mutation(() => ReviewSettingsPayload, {
    description:
      'Sets from how many stars, 3, 4 or 5, reviews publish by themselves, and how many days ' +
      'after delivery customers are asked for them. Reviews written before keep their status.',
  })
  @RequireScopes('write_settings')
  async reviewSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ReviewSettingsInput,
  ): Promise<ReviewSettingsPayload> {
    const result = await this.service.updateSettings(tenant, {
      ...('publishFrom' in input && { publishFrom: input.publishFrom ?? null }),
      ...('requestAfterDays' in input && { requestAfterDays: input.requestAfterDays ?? null }),
    });
    return Object.assign(new ReviewSettingsPayload(), {
      reviewSettings: result.ok ? Object.assign(new ReviewSettings(), result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  private async moderate(
    tenant: TenantContext,
    id: string,
    to: 'published' | 'hidden',
  ): Promise<ProductReviewPayload> {
    const reviewId = tryFromPublicId(id, 'productReview');
    return payload(
      reviewId
        ? await this.service.moderate(tenant, reviewId, to)
        : failOne(['id'], 'NOT_FOUND', NOT_FOUND),
    );
  }
}
