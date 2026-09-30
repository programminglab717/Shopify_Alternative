import { THEME_PREVIEW_HEADER, type ThemePreviewResponse } from '@hatti/storefront-api';
import { Controller, Get, Header, Headers, NotFoundException, Param } from '@nestjs/common';
import { ThemePreviewService } from './theme-preview.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Longer than any token of ours, so nothing larger is decrypted. */
const TOKEN_MAX = 512;

/**
 * Theme previews, as storefronts reach them (ADR-049): `GET /storefront/shops/{shop}/theme-preview`
 * with a preview link's token in `x-hatti-preview` gives the theme it shows, as saved now, and 404
 * once it shows none. The host application checks the storefront key before this runs.
 */
@Controller('storefront/shops/:shopId/theme-preview')
export class StorefrontThemePreviewController {
  constructor(private readonly previews: ThemePreviewService) {}

  @Get()
  @Header('cache-control', 'no-store')
  async preview(
    @Param('shopId') shopId: string,
    @Headers(THEME_PREVIEW_HEADER) token: string | undefined,
  ): Promise<ThemePreviewResponse> {
    if (!UUID.test(shopId) || !token || token.length > TOKEN_MAX) throw new NotFoundException();
    const found = await this.previews.open(shopId, token);
    if (!found) throw new NotFoundException();
    return {
      theme: {
        id: found.theme.id,
        name: found.theme.name,
        version: found.theme.version,
        base: found.theme.base,
        files: Object.fromEntries(found.files.map((file) => [file.filename, file.body])),
      },
      expiresAt: found.expiresAt.toISOString(),
    };
  }
}
