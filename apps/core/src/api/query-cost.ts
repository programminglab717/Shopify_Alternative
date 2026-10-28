import {
  ErrorCode,
  QUERY_COST,
  actualQueryCost,
  requestedQueryCost,
  type ApiContext,
  type CostedOperation,
  type TenantContext,
} from '@hatti/api';
import type { Logger } from '@hatti/logger';
import type { BucketLimits, LeakyBuckets } from '@hatti/ratelimit';
import type { FastifyRequest } from 'fastify';
import { GraphQLError } from 'graphql';
import type { MercuriusDriverConfig } from '@nestjs/mercurius';
import type { MercuriusContext } from 'mercurius';

/** What a query cost and what its caller has left, as `extensions.cost` tells, as in Shopify. */
export interface QueryCost {
  requestedQueryCost: number;
  /** Null for a query refused before it ran. */
  actualQueryCost: number | null;
  throttleStatus: {
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the Admin API costed the request's query (ADR-576). */
    queryCost?: QueryCost;
    /** Set when its query was refused for its cost, before it ran: a retry may run it. */
    queryRefused?: boolean;
  }
}

/** Each kind of caller's bucket, in each shop. */
export interface QueryCostLimits {
  /** Apps, each with its own in each shop it is in. */
  app: BucketLimits;
  /** Staff, each with their own in each shop, from the admin; Hatti's support likewise. */
  staff: BucketLimits;
}

export interface QueryCostOptions {
  /**
   * Where callers' buckets are kept. Without them, queries are still costed, and those costlier
   * than any may be refused, but none is throttled.
   */
  buckets: LeakyBuckets | null;
  limits: QueryCostLimits;
  /** The clock buckets restore by, in milliseconds; Date.now unless given. */
  now?: () => number;
}

/** The buckets' name in Redis. */
const BUCKET = 'admin-api';

type CostContext = MercuriusContext & ApiContext;

/** A query let through: what it asked, and the bucket it took from, if it took. */
interface Run {
  operation: CostedOperation;
  limits: BucketLimits;
  /** The bucket's subject; null when nothing was taken, as when Redis could not be reached. */
  subject: string | null;
}

function operationNameOf(request: FastifyRequest): string | null {
  const body = (request.method === 'GET' ? request.query : request.body) as {
    operationName?: unknown;
  } | null;
  return typeof body?.operationName === 'string' ? body.operationName : null;
}

/** One bucket per caller per shop: an app's limit in one shop leaves its others alone. */
function subjectOf(tenant: TenantContext): string {
  const actor = tenant.actor;
  const caller = actor.kind === 'app' ? actor.tokenId : actor.userId;
  return `${tenant.shopId}:${actor.kind}:${caller}`;
}

/**
 * Meters the Admin API as Shopify meters its own (ADR-576). Before a query runs, once it is
 * valid, it is costed ({@link requestedQueryCost}) and that many points are taken from its
 * caller's bucket in the shop: a query costlier than any one may be is refused with
 * MAX_COST_EXCEEDED, and one costlier than the bucket holds now with THROTTLED, neither taking
 * anything. Once it ran, what it did not use ({@link actualQueryCost}) goes back, and the answer
 * tells both costs and what is left in `extensions.cost`.
 *
 * When Redis cannot be reached, queries go through unmetered, each logged: an outage of Redis must
 * not take the Admin API down, and every shop's admin with it. While it lasts, queries are held
 * only by their single-query maximum, the depth limit and the database's statement timeout.
 */
export function queryCostHooks(
  options: QueryCostOptions,
  logger: Logger,
): NonNullable<MercuriusDriverConfig['hooks']> {
  const limits = options.limits;
  const now = options.now ?? Date.now;
  const runs = new WeakMap<MercuriusContext, Run>();

  async function take(
    subject: string,
    amount: number,
    bucket: BucketLimits,
  ): Promise<{ allowed: boolean; available: number; metered: boolean }> {
    const unmetered = {
      allowed: true,
      available: Math.max(0, bucket.maximum - amount),
      metered: false,
    };
    if (!options.buckets) return unmetered;
    try {
      const result = await options.buckets.take(BUCKET, subject, amount, bucket, now());
      return { ...result, metered: true };
    } catch (error) {
      logger.warn({ err: error }, 'query cost bucket unreachable; allowing');
      return unmetered;
    }
  }

  return {
    async preExecution(schema, document, context, variables) {
      const tenant = (context as CostContext).tenant;
      // A bulk operation's pages, run by the API itself without a request, aren't metered
      // (ADR-843).
      if (!tenant || !context.reply) return;
      const request = context.reply.request;
      const operation = { schema, document, variables, operationName: operationNameOf(request) };
      let requested: number;
      try {
        requested = requestedQueryCost(operation);
      } catch (error) {
        logger.error({ err: error }, 'could not cost a query; allowing');
        return;
      }

      const bucket = tenant.actor.kind === 'app' ? limits.app : limits.staff;
      // Apps may ask what Shopify's may at once; staff, whose admin asks a courier's statement's
      // 250 lines on one page, their whole bucket. No query costlier than a full bucket could run.
      const most =
        tenant.actor.kind === 'app' ? Math.min(QUERY_COST.maximum, bucket.maximum) : bucket.maximum;
      const tooCostly = requested > most;
      const subject = subjectOf(tenant);
      const taken = await take(subject, tooCostly ? 0 : requested, bucket);
      const cost: QueryCost = {
        requestedQueryCost: requested,
        actualQueryCost: null,
        throttleStatus: {
          maximumAvailable: bucket.maximum,
          currentlyAvailable: taken.available,
          restoreRate: bucket.restoreRate,
        },
      };
      request.queryCost = cost;
      request.queryRefused = tooCostly || !taken.allowed;

      if (tooCostly) {
        throw new GraphQLError(
          `This query costs ${requested} points, more than the ${most} any one query may. Ask ` +
            'for smaller pages, or fewer of them at once',
          { extensions: { code: ErrorCode.MaxCostExceeded, cost: requested, maxCost: most } },
        );
      }
      if (!taken.allowed) {
        const seconds = Math.ceil((requested - taken.available) / bucket.restoreRate);
        throw new GraphQLError(
          `Throttled: this query may cost ${requested} points and ${taken.available} are left, ` +
            `restoring ${bucket.restoreRate} a second. Try again in ${seconds} ` +
            `second${seconds === 1 ? '' : 's'}`,
          { extensions: { code: ErrorCode.Throttled } },
        );
      }
      runs.set(context, { operation, limits: bucket, subject: taken.metered ? subject : null });
    },

    async onResolution(execution, context) {
      const run = runs.get(context);
      const cost = context.reply?.request.queryCost;
      if (!run || !cost) return;
      const requested = cost.requestedQueryCost;
      let actual = requested;
      try {
        actual = actualQueryCost(run.operation, execution.data);
      } catch (error) {
        logger.error({ err: error }, 'could not cost what a query returned; charging all of it');
      }
      cost.actualQueryCost = actual;
      const unused = requested - actual;
      const status = cost.throttleStatus;
      if (unused > 0 && run.subject && options.buckets) {
        try {
          const { available } = await options.buckets.refund(
            BUCKET,
            run.subject,
            unused,
            run.limits,
            now(),
          );
          status.currentlyAvailable = available;
        } catch (error) {
          logger.warn({ err: error }, 'query cost bucket unreachable; refund lost');
        }
      } else if (unused > 0) {
        status.currentlyAvailable = Math.min(
          status.maximumAvailable,
          status.currentlyAvailable + unused,
        );
      }
      execution.extensions = { ...execution.extensions, cost };
    },
  };
}
