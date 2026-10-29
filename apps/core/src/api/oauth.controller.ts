import { AppInstallsService } from '@hatti/apps/public';
import { AuthError, PartnerAppsService } from '@hatti/identity/public';
import { Body, Controller, Header, HttpCode, HttpException, Post } from '@nestjs/common';

/** What the app sends: its client ID and secret, and the code the merchant's approval gave it. */
function grantOf(body: unknown): { clientId: string; clientSecret: string; code: string } | null {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const text = (name: string) => {
    const value = fields[name];
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  };
  const clientId = text('client_id');
  const clientSecret = text('client_secret');
  const code = text('code');
  return clientId && clientSecret && code ? { clientId, clientSecret, code } : null;
}

/**
 * A public app's token (DEV-05, ADR-851), as Shopify's apps get theirs: `POST
 * /admin/oauth/access_token` with `{ client_id, client_secret, code }`, as JSON or form-encoded as
 * OAuth libraries send it (ADR-914), the code the shop's owner
 * or a manager approved within ten minutes. `{ access_token, scope }`, the token the app then
 * sends in `x-hatti-access-token`, with the scopes approved, comma separated. A code is traded
 * once; installed again, an app's earlier token stops working.
 */
@Controller('admin/oauth')
export class OAuthController {
  constructor(
    private readonly partnerApps: PartnerAppsService,
    private readonly installs: AppInstallsService,
  ) {}

  @Post('access_token')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async accessToken(@Body() body: unknown): Promise<{ access_token: string; scope: string }> {
    const grant = grantOf(body);
    if (!grant) {
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description: 'Send client_id, client_secret and code, as JSON or as a form',
        },
        400,
      );
    }
    let approved;
    try {
      approved = await this.partnerApps.redeem(grant);
    } catch (error) {
      if (error instanceof AuthError) {
        throw new HttpException({ error: 'invalid_grant', error_description: error.message }, 400);
      }
      throw error;
    }
    const { accessToken } = await this.installs.install(approved.shopId, {
      publicAppId: approved.app.id,
      name: approved.app.name,
      scopes: approved.scopes,
      clientSecret: grant.clientSecret,
    });
    return { access_token: accessToken, scope: approved.scopes.join(',') };
  }
}
