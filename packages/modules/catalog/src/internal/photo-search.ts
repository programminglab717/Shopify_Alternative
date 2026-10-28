import { AiGateway, readPhotoForSearch, type AiImage } from '@hatti/ai';
import { AiCredits, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import {
  PHOTO_SEARCH_BYTES,
  SEARCH_RESULTS,
  type PhotoSearchRefusal,
  type PhotoSearchRequest,
  type PhotoSearchResponse,
} from '@hatti/storefront-api';
import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  Param,
  Post,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ProductService } from './product.service.js';

// Visual search (SRC-07, ADR-870): a shopper's photo, read by the AI into searches of the shop's
// catalog, from the most particular to the broadest; the shop's own search finds products by each
// in turn, and the first that finds any is shown, as a search the shopper could have typed. Off
// until the shop turns it on, as each photo spends one of its AI credits; a shop reads so many a
// day at most, however many shoppers send them. The photo is read and forgotten: what is kept is
// what came of it.

export const PHOTO_SEARCH_LIMITS = {
  /** Photos a shop reads a day, so that a script cannot spend its month's credits in an hour. */
  perDay: 300,
} as const;

/** Whether a shop reads shoppers' photos, and how many it read in the last day. */
export interface PhotoSearchSetting {
  enabled: boolean;
  /** Whether the host has an AI to read them: without one, none is read however it is set. */
  available: boolean;
  usedToday: number;
  limitPerDay: number;
}

/** What a photo's first bytes say it is, for the type it was sent as. */
const MAGIC: Readonly<Record<PhotoSearchRequest['mediaType'], (bytes: Buffer) => boolean>> = {
  'image/jpeg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/png': (bytes) => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/webp': (bytes) =>
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The photo a request carries, checked as far as its bytes go; null where it is not one. */
export function photoOf(body: unknown): AiImage | null {
  const { image, mediaType } = (body ?? {}) as Partial<PhotoSearchRequest>;
  if (typeof image !== 'string' || typeof mediaType !== 'string' || !(mediaType in MAGIC)) {
    return null;
  }
  // Base64 is four characters to three bytes.
  if (image.length > Math.ceil(PHOTO_SEARCH_BYTES / 3) * 4 || !BASE64.test(image)) return null;
  const data = Buffer.from(image, 'base64');
  if (data.length === 0 || !MAGIC[mediaType as PhotoSearchRequest['mediaType']](data)) return null;
  return { mediaType: mediaType as PhotoSearchRequest['mediaType'], data };
}

/** Photos the shop read since a day before `now`. */
async function searchesSince(tx: Tx, shopId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM catalog.photo_searches
     WHERE shop_id = ${shopId} AND created_at > ${since}`);
  return rows[0]!.count;
}

export type PhotoSearchOutcome = PhotoSearchResponse | { refused: PhotoSearchRefusal };

@Injectable()
export class PhotoSearchService {
  constructor(
    private readonly db: Database,
    private readonly products: ProductService,
    /** The AI gateway, where the host configured one (ADR-463): without it, no photo is read. */
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
    /** The AI credits of the shop's plan (ADR-533); without them, photos are not counted. */
    @Optional() @Inject(AiCredits) private readonly credits?: AiCredits | null,
  ) {}

  /** Whether the shop reads shoppers' photos. */
  async setting(tenant: TenantContext, now: Date = new Date()): Promise<PhotoSearchSetting> {
    return this.db.tenant(tenant.shopId, async (tx) => ({
      enabled: await this.enabledIn(tx, tenant.shopId),
      available: Boolean(this.ai),
      usedToday: await searchesSince(tx, tenant.shopId, now),
      limitPerDay: PHOTO_SEARCH_LIMITS.perDay,
    }));
  }

  /** Turns reading shoppers' photos on or off. */
  async set(tenant: TenantContext, enabled: boolean): Promise<PhotoSearchSetting> {
    await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO catalog.photo_search_settings (shop_id, enabled, updated_at)
        VALUES (${tenant.shopId}, ${enabled}, now())
        ON CONFLICT (shop_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`),
    );
    return this.setting(tenant);
  }

  private async enabledIn(tx: Tx, shopId: string): Promise<boolean> {
    const { rows } = await tx.execute<{ enabled: boolean }>(sql`
      SELECT enabled FROM catalog.photo_search_settings WHERE shop_id = ${shopId}`);
    return rows[0]?.enabled ?? false;
  }

  /**
   * A shopper's `photo`, read into the most particular search that finds the shop's products,
   * and those it finds; or why the shop reads none now.
   */
  async search(
    shopId: string,
    photo: AiImage,
    now: Date = new Date(),
  ): Promise<PhotoSearchOutcome> {
    const ai = this.ai;
    if (!ai) return { refused: 'unavailable' };
    const read = await this.db.tenant(shopId, async (tx) => ({
      enabled: await this.enabledIn(tx, shopId),
      used: await searchesSince(tx, shopId, now),
    }));
    if (!read.enabled) return { refused: 'unavailable' };
    if (read.used >= PHOTO_SEARCH_LIMITS.perDay) return { refused: 'too_many' };
    const balance = await this.credits?.balanceOf(shopId, now);
    if (balance && balance.left <= 0) return { refused: 'no_credits' };

    const result = await readPhotoForSearch(ai, photo);
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    let answer: PhotoSearchResponse = { query: null, productIds: [] };
    if (result.ok && result.value.product) {
      const { searches } = result.value;
      answer = await this.db.tenant(shopId, async (tx) => {
        for (const search of searches) {
          const productIds = await this.products.searchIdsOf(tx, shopId, search, SEARCH_RESULTS);
          if (productIds.length > 0) return { query: search, productIds };
        }
        // None found any: the broadest, for the shopper to change.
        return { query: searches.at(-1)!, productIds: [] };
      });
    }
    const outcome = !result.ok
      ? result.reason
      : !result.value.product
        ? 'no_product'
        : answer.productIds.length > 0
          ? 'found'
          : 'none';
    await this.db.tenant(shopId, (tx) =>
      tx.execute(sql`
        INSERT INTO catalog.photo_searches
          (shop_id, outcome, query, input_tokens, output_tokens, created_at)
        VALUES (${shopId}, ${outcome}, ${answer.query}, ${usage.inputTokens},
                ${usage.outputTokens}, ${now.toISOString()})`),
    );
    if (!result.ok) return { refused: 'unavailable' };
    await this.credits?.spend(shopId, 'visual_search', now);
    return answer;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why a photo was read into no search, as the storefront is told it. */
const REFUSALS: Readonly<Record<PhotoSearchRefusal, number>> = {
  unavailable: 503,
  no_credits: 402,
  too_many: 429,
};

/**
 * Visual search, as storefronts reach it (ADR-870): `POST /storefront/shops/{shop}/search/photo`
 * with a {@link PhotoSearchRequest}. The host application checks the storefront key before this
 * runs; the storefront limits how many an address sends.
 */
@Controller('storefront/shops/:shopId/search/photo')
export class StorefrontPhotoSearchController {
  constructor(private readonly service: PhotoSearchService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async search(
    @Param('shopId') shopId: string,
    @Body() body: unknown,
  ): Promise<PhotoSearchResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const photo = photoOf(body);
    if (!photo) {
      throw new BadRequestException(
        `Send a JPEG, PNG or WebP photo of ${PHOTO_SEARCH_BYTES.toLocaleString('en')} bytes at most, base64`,
      );
    }
    const outcome = await this.service.search(shopId, photo);
    if ('refused' in outcome) {
      throw new HttpException({ refused: outcome.refused }, REFUSALS[outcome.refused]);
    }
    return outcome;
  }
}
