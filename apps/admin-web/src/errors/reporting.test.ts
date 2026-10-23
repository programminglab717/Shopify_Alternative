import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { createReporter, pageOf, reportOf, reportUncaught } from './reporting';

describe("The admin's browser errors reported to the core (ADR-745)", () => {
  it('names a page by its path, its IDs taken out, and never its query', () => {
    expect(pageOf('/shops/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/orders/0193f00d')).toBe(
      '/shops/:id/orders/:id',
    );
    expect(pageOf('/shops/:id/settings/couriers')).toBe('/shops/:id/settings/couriers');
  });

  it("reports an error with its stack, but not the API's refusals nor an abort", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'total')");
    expect(reportOf(error, '/shops/0193a1b2c3d4/orders', 'admin-web@abc123')).toMatchObject({
      type: 'TypeError',
      message: error.message,
      stack: expect.stringContaining('TypeError'),
      page: '/shops/:id/orders',
      release: 'admin-web@abc123',
    });
    expect(reportOf(new ApiError(500, 'INTERNAL', 'Something went wrong'), '/')).toBeNull();
    expect(reportOf(new DOMException('aborted', 'AbortError'), '/')).toBeNull();
    // What was thrown that is no error is reported as its words.
    expect(reportOf('quota exceeded', '/')).toEqual({
      type: 'Error',
      message: 'quota exceeded',
      page: '/',
    });
    expect(reportOf(undefined, '/')).toBeNull();
  });

  it('sends each fault once, ten at most a page, and never fails for a report not sent', async () => {
    const sent: unknown[] = [];
    const reporter = createReporter({
      pathname: () => '/shops/0193a1b2c3d4/home',
      send: async (body) => {
        sent.push(JSON.parse(body));
        if (sent.length === 2) throw new Error('offline');
      },
    });
    reporter.report(new Error('boom'));
    reporter.report(new Error('boom'));
    expect(sent).toEqual([expect.objectContaining({ message: 'boom', page: '/shops/:id/home' })]);
    for (let i = 0; i < 20; i++) reporter.report(new Error(`fault ${i}`));
    await Promise.resolve();
    expect(sent).toHaveLength(10);
  });

  it('reports what nothing caught: an error thrown, and a rejection nothing handled', () => {
    const reported: unknown[] = [];
    const target = new EventTarget() as Window;
    reportUncaught({ report: (error) => reported.push(error) }, target);
    const thrown = new RangeError('Invalid time value');
    target.dispatchEvent(
      Object.assign(new Event('error'), { error: thrown, message: thrown.message }),
    );
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'failed' }));
    expect(reported).toEqual([thrown, 'failed']);
  });
});
