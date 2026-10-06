import type { Logger } from '@hatti/logger';
import { describe, expect, it, vi } from 'vitest';
import { ScheduledArticles } from './scheduled-articles.js';

describe('Articles shown when their time comes (ADR-215)', () => {
  it("shows each shop's articles due, one shop's failure not the others'", async () => {
    const articles = {
      shopsWithArticlesDue: vi.fn(async () => ['shop-a', 'shop-b', 'shop-c']),
      showDue: vi.fn(async (shopId: string) => {
        if (shopId === 'shop-b') throw new Error('database down');
        return shopId === 'shop-a' ? 2 : 1;
      }),
    };
    const warned: unknown[] = [];
    const logger = { info: vi.fn(), warn: (obj: unknown) => warned.push(obj) } as unknown as Logger;
    expect(await new ScheduledArticles(articles, logger).sweep()).toBe(3);
    expect(articles.showDue.mock.calls.map(([shopId]) => shopId)).toEqual([
      'shop-a',
      'shop-b',
      'shop-c',
    ]);
    expect(warned).toEqual([expect.objectContaining({ shopId: 'shop-b' })]);
  });
});
