import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { generateAccessToken } from '@hatti/api';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_GRAPHQL_PATH } from './api/constants.js';

const server = testDatabaseServer();
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

// OTLP JSON is checked by the assertions rather than typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface ExportedSpan {
  scope: string;
  name: string;
  traceId: string;
  attributes: Record<string, unknown>;
}

/** A stand-in OpenTelemetry collector that keeps what it receives over OTLP/HTTP (JSON). */
function startCollector(): Promise<{
  server: Server;
  port: number;
  spans: ExportedSpan[];
  metrics: Set<string>;
}> {
  const spans: ExportedSpan[] = [];
  const metrics = new Set<string>();
  const collector = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const payload = JSON.parse(body || '{}') as Record<string, Json[]>;
      for (const resource of payload.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            spans.push({
              scope: scope.scope?.name,
              name: span.name,
              traceId: span.traceId,
              attributes: Object.fromEntries(
                (span.attributes ?? []).map((a: { key: string; value: object }) => [
                  a.key,
                  Object.values(a.value)[0],
                ]),
              ),
            });
          }
        }
      }
      for (const resource of payload.resourceMetrics ?? []) {
        for (const scope of resource.scopeMetrics ?? []) {
          for (const metric of scope.metrics ?? []) metrics.add(metric.name);
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  return new Promise((resolve) => {
    collector.listen(0, '127.0.0.1', () => {
      resolve({
        server: collector,
        port: (collector.address() as AddressInfo).port,
        spans,
        metrics,
      });
    });
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Runs the built API the way production does (node --import ./dist/instrumentation.js), so a
 * dependency upgrade that silently breaks instrumentation fails here.
 */
describe.skipIf(!server)('telemetry', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let collector: Awaited<ReturnType<typeof startCollector>>;
  let api: ChildProcess;
  let baseUrl: string;
  const shopId = newId();
  const { token, hash, hint } = generateAccessToken();

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Traced Shop')`, [shopId]);
    await admin.query(
      `INSERT INTO apps.access_tokens (shop_id, name, token_hash, token_hint, scopes)
       VALUES ($1, 'test', $2, $3, '{write_products}')`,
      [shopId, hash, hint],
    );
    collector = await startCollector();
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    api = spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/main.js'], {
      cwd: APP_DIR,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_URL: testDb.appUrl,
        DATABASE_IDENTITY_URL: testDb.identityUrl,
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        ENCRYPTION_KEYS: `test:${Buffer.alloc(32, 3).toString('base64')}`,
        PASSWORD_BREACH_CHECK: 'false',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
        OTEL_BSP_SCHEDULE_DELAY: '100',
        OTEL_METRIC_EXPORT_INTERVAL: '500',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await vi.waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/healthz`);
        expect(response.ok).toBe(true);
      },
      { timeout: 20_000, interval: 200 },
    );
  });

  afterAll(async () => {
    if (api && api.exitCode === null) {
      api.kill('SIGTERM');
      await once(api, 'exit');
    }
    collector?.server.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('traces a request through GraphQL and Postgres, tagged with the shop', async () => {
    const response = await fetch(`${baseUrl}${ADMIN_GRAPHQL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatti-access-token': token },
      body: JSON.stringify({
        query: 'mutation { productCreate(input: { title: "Traced Ajrak" }) { product { id } } }',
      }),
    });
    expect(response.status).toBe(200);

    await vi.waitFor(
      () => {
        const request = collector.spans.find(
          (span) => span.name === 'request' && span.attributes['hatti.shop_id'] === shopId,
        );
        expect(request?.attributes['hatti.actor']).toBe('app');
        const trace = collector.spans.filter((span) => span.traceId === request?.traceId);
        const scopes = new Set(trace.map((span) => span.scope));
        expect(scopes).toContain('@opentelemetry/instrumentation-http');
        expect(scopes).toContain('@opentelemetry/instrumentation-graphql');
        expect(scopes).toContain('@opentelemetry/instrumentation-pg');
        expect(trace.map((span) => span.name)).toContain('tenant transaction');
      },
      { timeout: 10_000, interval: 200 },
    );

    // The outbox row carries the request's trace, for the worker to continue.
    const { rows } = await admin.query<{ trace_context: string }>(
      'SELECT trace_context FROM platform.outbox_events',
    );
    const request = collector.spans.find((span) => span.name === 'request');
    expect(rows[0]?.trace_context).toMatch(new RegExp(`^00-${request?.traceId}-`));
  });

  it('never traces health probes, and exports HTTP metrics', async () => {
    await fetch(`${baseUrl}/readyz`);
    await vi.waitFor(() => expect(collector.metrics).toContain('http.server.request.duration'), {
      timeout: 10_000,
      interval: 200,
    });
    const probes = collector.spans.filter((span) =>
      ['/healthz', '/readyz'].includes(String(span.attributes['url.path'])),
    );
    expect(probes).toEqual([]);
  });

  it('flushes and exits cleanly on SIGTERM', async () => {
    api.kill('SIGTERM');
    const [code] = await once(api, 'exit');
    expect(code).toBe(0);
  });
});
