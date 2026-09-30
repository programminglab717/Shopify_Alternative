import { StorefrontSite, shopProfile, type TenantContext } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { Injectable } from '@nestjs/common';
import type { ThemeFileRecord, ThemeRecord } from './records.js';
import { ThemeService } from './theme.service.js';

/** How long a preview link lasts: long enough to send for a second opinion, as Shopify's do. */
export const PREVIEW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a preview token holds, encrypted: the theme, and when the link ends, in seconds. */
interface PreviewClaims {
  theme: string;
  until: number;
}

/** A theme a preview link shows, as saved now. */
export interface ThemePreview {
  theme: ThemeRecord;
  files: ThemeFileRecord[];
  expiresAt: Date;
}

/**
 * Links that show a theme of the shop's on its storefront, published or not (ADR-049), such as
 * one being prepared for Eid: to look at, or to send for a second opinion. The token in a link
 * names the theme and when the link ends, encrypted and bound to the shop, so nothing is stored;
 * the storefront hands it back for the theme's files.
 */
@Injectable()
export class ThemePreviewService {
  constructor(
    private readonly db: Database,
    private readonly themes: ThemeService,
    private readonly box: SecretBox,
    private readonly storefronts: StorefrontSite,
  ) {}

  /**
   * A link to one of the shop's themes on its storefront, at its handle's subdomain, for
   * {@link PREVIEW_DAYS} from `now`.
   */
  async link(
    tenant: TenantContext,
    themeId: string,
    now = new Date(),
  ): Promise<{ url: string; expiresAt: Date }> {
    const { handle } = await this.db.tenant(tenant.shopId, (tx) => shopProfile(tx, tenant.shopId));
    const expiresAt = new Date(now.getTime() + PREVIEW_DAYS * DAY_MS);
    const claims: PreviewClaims = { theme: themeId, until: Math.floor(expiresAt.getTime() / 1000) };
    const url = new URL(this.storefronts.url(handle));
    url.searchParams.set(
      'preview',
      this.box.encrypt(JSON.stringify(claims), context(tenant.shopId)),
    );
    return { url: url.href, expiresAt: new Date(claims.until * 1000) };
  }

  /**
   * The theme a preview link's `token` shows on the shop's storefront, as saved now; null for a
   * token of another shop's, one whose link has ended, or one whose theme is gone.
   */
  async open(shopId: string, token: string, now = new Date()): Promise<ThemePreview | null> {
    const claims = this.#claims(shopId, token);
    if (!claims || claims.until * 1000 <= now.getTime()) return null;
    const found = await this.db.tenant(shopId, (tx) =>
      this.themes.themeOf(tx, shopId, claims.theme),
    );
    return found && { ...found, expiresAt: new Date(claims.until * 1000) };
  }

  #claims(shopId: string, token: string): PreviewClaims | null {
    let claims: Partial<PreviewClaims>;
    try {
      claims = JSON.parse(this.box.decrypt(token, context(shopId)).toString('utf8'));
    } catch {
      // Not one of ours, or not for this shop: the key or the shop it is bound to differs.
      return null;
    }
    return typeof claims.theme === 'string' && Number.isInteger(claims.until)
      ? (claims as PreviewClaims)
      : null;
  }
}

/** Binds a token to its shop, so another shop's storefront cannot use it. */
function context(shopId: string): string {
  return `theme-preview:${shopId}`;
}
