import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * What the storefront logs of its requests (ADR-744): an answer that failed with a 5xx, at
 * error, so that it reaches the error tracker; nothing of the rest, which the edge's logs have.
 * A failed answer is named by its route's pattern and the first part of its path, as
 * "/products", never by its whole address, which may hold an order's, a payment's or a
 * preview's token.
 */
export class StorefrontLogs extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(): void {}

  override routeNotFound(): void {}

  override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if (reply.statusCode < 500) return;
    reply.log.error(
      {
        err: error,
        status: reply.statusCode,
        method: request.method,
        route: request.routeOptions.url ?? null,
        path: `/${request.url.split(/[/?#]/, 2)[1] ?? ''}`,
        host: request.hostname,
      },
      error.message,
    );
  }
}
