import { describe, expect, it } from 'vitest';
import { OrderTemplates } from './order-templates.js';

describe("Hatti's order templates sent to shops' own accounts (ADR-537)", () => {
  it('sends each shop due the library, one failing not stopping the rest, and logs what Meta refused', async () => {
    const calls: [string, string][] = [];
    const logs: [string, unknown, string][] = [];
    const graph = { templatesOf: async () => ({ ok: true }), submitTemplate: async () => ({}) };
    const templates = {
      libraryDue: async () => ['shop-a', 'shop-b', 'shop-c'],
      sendLibrary: async (shopId: string, orderPage: string) => {
        calls.push([shopId, orderPage]);
        if (shopId === 'shop-b') throw new Error('database gone');
        return shopId === 'shop-a'
          ? { submitted: 33, adopted: 1, errors: ['hatti_order_shipped (ur): Meta 100: too close'] }
          : { submitted: 0, adopted: 0, errors: [] };
      },
    };
    const logger = {
      info: (fields: unknown, message: string) => logs.push(['info', fields, message]),
      warn: (fields: unknown, message: string) => logs.push(['warn', fields, message]),
    };
    const sweep = new OrderTemplates(
      templates as never,
      graph as never,
      'https://hatti.pk/o/',
      logger as never,
    );

    expect(await sweep.sweep(new Date('2026-10-17T10:00:00Z'))).toBe(34);
    expect(calls).toEqual([
      ['shop-a', 'https://hatti.pk/o/'],
      ['shop-b', 'https://hatti.pk/o/'],
      ['shop-c', 'https://hatti.pk/o/'],
    ]);
    expect(logs.map(([level, , message]) => [level, message])).toEqual([
      ['info', "order templates sent to the shop's WhatsApp account"],
      ['warn', 'order templates refused by Meta'],
      ['warn', 'order templates not sent'],
    ]);
  });
});
