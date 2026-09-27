import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

function capture(level: 'info' | 'debug' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    name: 'test',
    level,
    base: { cell: 'test-1' },
    destination: { write: (line: string) => lines.push(JSON.parse(line)) },
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes JSON with name, base fields, string level and ISO time', () => {
    const { logger, lines } = capture();
    logger.info({ orderId: 'ord_123' }, 'order confirmed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      name: 'test',
      cell: 'test-1',
      orderId: 'ord_123',
      msg: 'order confirmed',
    });
    expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts credentials and personal data at the top level and one level deep', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        token: 'shpat_secret',
        phone: '+923001234567',
        customer: { id: 'cus_1', email: 'a@b.pk', cnic: '35202-1234567-1' },
        req: { headers: { authorization: 'Bearer abc', 'x-hatti-access-token': 'tok' } },
      },
      'request',
    );
    const line = lines[0] as {
      token: string;
      phone: string;
      customer: Record<string, string>;
      req: { headers: Record<string, string> };
    };
    expect(line.token).toBe('[redacted]');
    expect(line.phone).toBe('[redacted]');
    expect(line.customer).toEqual({ id: 'cus_1', email: '[redacted]', cnic: '[redacted]' });
    expect(line.req.headers.authorization).toBe('[redacted]');
    expect(line.req.headers['x-hatti-access-token']).toBe('[redacted]');
  });

  it('keeps redaction in child loggers', () => {
    const { logger, lines } = capture();
    logger.child({ requestId: 'r1' }).warn({ password: 'hunter2' }, 'login failed');
    expect(lines[0]).toMatchObject({ requestId: 'r1', password: '[redacted]', level: 'warn' });
  });

  it('serialises errors', () => {
    const { logger, lines } = capture();
    logger.error({ err: new TypeError('boom') }, 'failed');
    expect(lines[0]?.err).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect(String((lines[0]?.err as { stack: string }).stack)).toContain('TypeError: boom');
  });

  it('adds trace and span ids inside a traced operation', () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const { logger, lines } = capture();
    const span = trace.getTracer('test').startSpan('operation');
    context.with(trace.setSpan(context.active(), span), () => logger.info('inside'));
    span.end();
    logger.info('outside');
    const { traceId, spanId } = span.spanContext();
    expect(lines[0]).toMatchObject({ msg: 'inside', trace_id: traceId, span_id: spanId });
    expect(lines[1]).not.toHaveProperty('trace_id');
  });

  it('filters by level', () => {
    const { logger, lines } = capture('info');
    logger.debug('hidden');
    logger.info('shown');
    expect(lines.map((l) => l.msg)).toEqual(['shown']);
  });
});
