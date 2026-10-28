import { createHmac, randomUUID } from 'node:crypto';
import { CurrentTenant, deniedToRole, type TenantContext } from '@hatti/api';
import { AppInstallsService } from '@hatti/apps/public';
import { PartnerAppsService } from '@hatti/identity/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, Field, GraphQLISODateTime, ID, ObjectType, Query, Resolver } from '@nestjs/graphql';

/** How long an embedded app's session token lasts: a minute, as Shopify's do. */
export const APP_SESSION_SECONDS = 60;

@ObjectType({
  description:
    'An installed app opened inside the admin (DEV-06, ADR-852): the address its frame loads, ' +
    'carrying a session token the app checks with its client secret.',
})
export class AppSession {
  @Field()
  name!: string;

  @Field({ description: "The app's address, with `shop`, `embedded=1` and `id_token`." })
  url!: string;

  @Field({ description: 'A JWT signed HS256 with the client secret, lasting a minute.' })
  token!: string;

  @Field(() => GraphQLISODateTime)
  expiresAt!: Date;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * A session token, as Shopify's App Bridge gives apps: who is looking, in which shop, for which
 * app, signed with the app's client secret so that it can tell the token is Hatti's.
 */
export function appSessionToken(
  claims: { shop: string; user: string; session: string; clientId: string },
  secret: string,
  now: Date,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({
      iss: 'hatti',
      dest: claims.shop,
      aud: claims.clientId,
      sub: claims.user,
      sid: claims.session,
      iat,
      nbf: iat,
      exp: iat + APP_SESSION_SECONDS,
      jti: randomUUID(),
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * An installed public app opened inside the admin (ADR-852): the core puts the install, which the
 * apps module keeps with its secret, together with where the partner's app answers, which identity
 * keeps. The shop's staff alone open apps, as they are the ones the token names.
 */
@Resolver(() => AppSession)
export class AppSessionResolver {
  constructor(
    private readonly installs: AppInstallsService,
    private readonly partnerApps: PartnerAppsService,
  ) {}

  @Query(() => AppSession, {
    nullable: true,
    description: 'Opens the installed app `id` inside the admin; null for no such app installed.',
  })
  async appSession(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AppSession | null> {
    const { actor } = tenant;
    if (actor.kind !== 'staff') {
      throw deniedToRole("Access denied. The shop's staff open its apps.");
    }
    const uuid = tryFromPublicId(id, 'accessToken');
    const key = uuid ? await this.installs.sessionKeyOf(tenant, uuid) : null;
    const app = key ? await this.partnerApps.embedOf(key.publicAppId) : null;
    if (!key || !app) return null;
    const now = new Date();
    const shop = toPublicId('shop', tenant.shopId);
    const token = appSessionToken(
      {
        shop,
        user: toPublicId('user', actor.userId),
        session: toPublicId('session', actor.sessionId),
        clientId: app.clientId,
      },
      key.secret,
      now,
    );
    const url = new URL(app.appUrl);
    url.searchParams.set('shop', shop);
    url.searchParams.set('embedded', '1');
    url.searchParams.set('id_token', token);
    return Object.assign(new AppSession(), {
      name: key.name,
      url: url.toString(),
      token,
      expiresAt: new Date(now.getTime() + APP_SESSION_SECONDS * 1000),
    });
  }
}
