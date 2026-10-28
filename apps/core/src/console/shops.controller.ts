import type { Database, Db } from '@hatti/db';
import {
  AuthErrorFilter,
  ConsoleAuthService,
  ConsoleGuard,
  consoleAgentOf,
} from '@hatti/identity/public';
import { isUuid, toPublicId, tryFromPublicId } from '@hatti/ids';
import { CourierCityReview } from '@hatti/logistics/public';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { consoleError } from './console.controller.js';
import { CONSOLE_DATABASE, consoleWords, notFound } from './trust.controller.js';

/** The identity login, as the console's server has it. */
export const CONSOLE_IDENTITY_DB = Symbol('CONSOLE_IDENTITY_DB');

/** The merchant admin's address, where an agent looks at a shop open to them; null unless set. */
export const CONSOLE_ADMIN_URL = Symbol('CONSOLE_ADMIN_URL');

type ShopRow = {
  id: string;
  name: string;
  handle: string;
  status: string;
  development: boolean;
  created_at: Date | string;
  plan: string | null;
};

const shopJson = (row: ShopRow) => ({
  id: toPublicId('shop', row.id),
  name: row.name,
  handle: row.handle,
  status: row.status,
  development: row.development,
  plan: row.plan ?? 'free',
  createdAt: new Date(row.created_at).toISOString(),
});

const SHOP_COLUMNS = sql`s.id, s.name, s.handle, s.status, s.development, s.created_at, b.plan`;
const COURIER = /^[a-z][a-z_]{1,29}$/;

/**
 * A shop as Hatti's people look it up (ADR-881): found by its name, handle or ID, then its
 * standing at a glance — plan and status, its owner and how to reach them, whether Hatti verified
 * it, what waits for Hatti of it, whether its owner lets support look now, and what was done to it
 * in the console. Looking one up is logged, as it shows its owner's details. And couriers' names
 * for cities across shops (ADR-260), reviewed, kept and forgotten, as `courier-cities` has them.
 */
@Controller('console/api')
@UseGuards(ConsoleGuard)
@UseFilters(AuthErrorFilter)
export class ConsoleShopsController {
  readonly #cities: CourierCityReview;

  constructor(
    private readonly console: ConsoleAuthService,
    @Inject(CONSOLE_DATABASE) private readonly database: Database,
    @Inject(CONSOLE_IDENTITY_DB) private readonly identity: Db,
    @Inject(CONSOLE_ADMIN_URL) private readonly adminUrl: string | null,
  ) {
    this.#cities = new CourierCityReview(database);
  }

  /** Shops whose name or handle has `query` in it, or whose ID it is: the latest first, 20 at most. */
  @Get('shops')
  async find(@Query('query') query?: string) {
    const words = (query ?? '').trim().slice(0, 100);
    if (words.length < 2) return { shops: [] };
    const id = tryFromPublicId(words, 'shop') ?? (isUuid(words) ? words : null);
    const like = `%${words.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const { rows } = await this.database.system((tx) =>
      tx.execute<ShopRow>(sql`
        SELECT ${SHOP_COLUMNS}
          FROM control.shops s LEFT JOIN billing.subscriptions b ON b.shop_id = s.id
         WHERE s.name ILIKE ${like} OR s.handle ILIKE ${like}
               ${id ? sql`OR s.id = ${id}` : sql``}
         ORDER BY s.created_at DESC LIMIT 20`),
    );
    return { shops: rows.map(shopJson) };
  }

  /** A shop's standing, by its ID: each look logged, as it shows its owner's details. */
  @Get('shops/:id')
  async shop(@Param('id') id: string, @Req() request: FastifyRequest) {
    const agent = consoleAgentOf(request);
    const shopId = tryFromPublicId(id, 'shop');
    if (!shopId) throw notFound('shop');
    const standing = await this.database.system(async (tx) => {
      const { rows } = await tx.execute<ShopRow>(sql`
        SELECT ${SHOP_COLUMNS}
          FROM control.shops s LEFT JOIN billing.subscriptions b ON b.shop_id = s.id
         WHERE s.id = ${shopId}`);
      if (!rows[0]) return null;
      const { rows: counts } = await tx.execute<{
        verified: string[] | null;
        reports: number;
        requests: number;
        signals: number;
        down_since: Date | string | null;
      }>(sql`
        SELECT (SELECT array_agg(level ORDER BY level) FROM trust.verifications
                 WHERE shop_id = ${shopId} AND status = 'approved') AS verified,
               (SELECT count(*)::int FROM trust.reports
                 WHERE shop_id = ${shopId} AND status = 'open') AS reports,
               (SELECT count(*)::int FROM billing.support_requests
                 WHERE shop_id = ${shopId} AND status = 'open') AS requests,
               (SELECT count(*)::int FROM trust.store_signals
                 WHERE shop_id = ${shopId} AND cleared_at IS NULL) AS signals,
               (SELECT max(created_at) FROM trust.takedowns
                 WHERE shop_id = ${shopId} AND restored_at IS NULL) AS down_since`);
      return { shop: rows[0], counts: counts[0]! };
    });
    if (!standing) throw notFound('shop');
    await this.console.record(agent, 'shop.view', id);
    const { rows: owners } = await this.identity.execute<{
      name: string;
      email: string | null;
      phone_e164: string | null;
    }>(sql`
      SELECT u.name, u.email, u.phone_e164 FROM identity.memberships m
        JOIN identity.users u ON u.id = m.user_id
       WHERE m.shop_id = ${shopId} AND m.role = 'owner'`);
    const { rows: grants } = await this.identity.execute<{
      expires_at: Date | string;
      note: string | null;
    }>(sql`
      SELECT expires_at, note FROM identity.support_grants
       WHERE shop_id = ${shopId} AND ended_at IS NULL AND expires_at > now()`);
    const actions = [
      ...(await this.console.actions({ subject: id, first: 20 })),
      ...(await this.console.actions({ subject: standing.shop.handle, first: 20 })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 20);
    const { counts } = standing;
    return {
      shop: shopJson(standing.shop),
      owner: owners[0]
        ? { name: owners[0].name, email: owners[0].email, phone: owners[0].phone_e164 }
        : null,
      verified: counts.verified ?? [],
      openReports: counts.reports,
      openSupportRequests: counts.requests,
      standingSignals: counts.signals,
      downSince: counts.down_since ? new Date(counts.down_since).toISOString() : null,
      supportAccess: grants[0]
        ? { until: new Date(grants[0].expires_at).toISOString(), note: grants[0].note }
        : null,
      actions: actions.map((action) => ({
        email: action.email,
        action: action.action,
        subject: action.subject,
        at: action.at.toISOString(),
      })),
    };
  }

  /**
   * Shops whose owners let support look now (ADR-156), the soonest to end first: what for, until
   * when, and where to look at each in the admin, signed in to it as an agent (ADR-882).
   */
  @Get('support-access')
  async supportAccess() {
    const { rows: grants } = await this.identity.execute<{
      shop_id: string;
      note: string | null;
      created_at: Date | string;
      expires_at: Date | string;
      granted_by: string;
    }>(sql`
      SELECT g.shop_id, g.note, g.created_at, g.expires_at, u.name AS granted_by
        FROM identity.support_grants g JOIN identity.users u ON u.id = g.granted_by
       WHERE g.ended_at IS NULL AND g.expires_at > now()
       ORDER BY g.expires_at`);
    if (grants.length === 0) return { shops: [] };
    const { rows: shops } = await this.database.system((tx) =>
      tx.execute<{ id: string; name: string; handle: string }>(sql`
        SELECT id, name, handle FROM control.shops
         WHERE id IN (${sql.join(
           grants.map((grant) => sql`${grant.shop_id}`),
           sql`, `,
         )}) AND status = 'active'`),
    );
    const byId = new Map(shops.map((shop) => [shop.id, shop]));
    return {
      shops: grants.flatMap((grant) => {
        const shop = byId.get(grant.shop_id);
        if (!shop) return [];
        const id = toPublicId('shop', shop.id);
        return [
          {
            shop: { id, name: shop.name, handle: shop.handle },
            note: grant.note,
            grantedBy: grant.granted_by,
            since: new Date(grant.created_at).toISOString(),
            until: new Date(grant.expires_at).toISOString(),
            adminUrl: this.adminUrl ? `${this.adminUrl.replace(/\/+$/, '')}/${id}` : null,
          },
        ];
      }),
    };
  }

  /** The couriers shops or Hatti have named cities with. */
  @Get('courier-cities')
  async couriers() {
    const { rows } = await this.database.system((tx) =>
      tx.execute<{ courier: string }>(sql`
        SELECT courier FROM logistics.shop_courier_cities
        UNION SELECT courier FROM logistics.courier_cities
        ORDER BY courier`),
    );
    return { couriers: rows.map((row) => row.courier) };
  }

  /** Shops' names for cities with `courier`, which shops agree on, and Hatti's own. */
  @Get('courier-cities/:courier')
  async cities(@Param('courier') courier: string) {
    if (!COURIER.test(courier)) throw notFound('courier');
    return this.#cities.review(courier);
  }

  /** Keeps Hatti's name for a city with `courier`, `{ city, courierCity }`, before shops'. */
  @Post('courier-cities/:courier/keep')
  @HttpCode(200)
  async keep(
    @Param('courier') courier: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const city = consoleWords(body, 'city', 100, { message: 'Name the city' });
    const courierCity = consoleWords(body, 'courierCity', 100, {
      message: "Give the courier's name for it",
    });
    if (!COURIER.test(courier)) throw notFound('courier');
    await this.console.record(consoleAgentOf(request), 'courier_city.keep', courier, {
      city,
      courierCity,
    });
    try {
      await this.#cities.keep(courier, city, courierCity);
    } catch (error) {
      throw consoleError(422, 'INVALID', (error as Error).message);
    }
    return { kept: { city, courierCity } };
  }

  /** Forgets Hatti's name for `{ city }` with `courier`: shops' names count again. */
  @Post('courier-cities/:courier/forget')
  @HttpCode(200)
  async forget(
    @Param('courier') courier: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const city = consoleWords(body, 'city', 100, { message: 'Name the city' });
    if (!COURIER.test(courier)) throw notFound('courier');
    await this.console.record(consoleAgentOf(request), 'courier_city.forget', courier, { city });
    if (!(await this.#cities.forget(courier, city))) {
      throw notFound(`name of Hatti's for ${city} with ${courier}`);
    }
    return { forgotten: city };
  }
}
