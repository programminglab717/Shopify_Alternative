import type { Logger } from '@hatti/logger';
import { describe, expect, it, vi } from 'vitest';
import { ScheduledContent, scheduledKinds } from './scheduled-content.js';

describe('Articles and pages shown when their time comes (ADR-215, ADR-217)', () => {
  it("shows each shop's articles and pages due, one shop's failure not the others'", async () => {
    const articles = {
      shopsWithArticlesDue: vi.fn(async () => ['shop-a', 'shop-b', 'shop-c']),
      showDue: vi.fn(async (shopId: string) => {
        if (shopId === 'shop-b') throw new Error('database down');
        return shopId === 'shop-a' ? 2 : 1;
      }),
    };
    const pages = {
      shopsWithPagesDue: vi.fn(async () => ['shop-b']),
      showDue: vi.fn(async () => 1),
    };
    const warned: unknown[] = [];
    const logger = { info: vi.fn(), warn: (obj: unknown) => warned.push(obj) } as unknown as Logger;
    const sweeps = new ScheduledContent(scheduledKinds(articles, pages), logger);
    expect(await sweeps.sweep()).toEqual({ articles: 3, pages: 1 });
    expect(articles.showDue.mock.calls.map(([shopId]) => shopId)).toEqual([
      'shop-a',
      'shop-b',
      'shop-c',
    ]);
    expect(pages.showDue).toHaveBeenCalledWith('shop-b');
    expect(warned).toEqual([expect.objectContaining({ shopId: 'shop-b', kind: 'articles' })]);
  });
});
