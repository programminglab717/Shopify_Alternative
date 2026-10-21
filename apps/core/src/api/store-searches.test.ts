import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { SEARCH_REPORT_ROWS, searchDays, storeSearchesOf } from './store-searches.resolver.js';

describe('What shoppers searched for (SRC-06, ADR-683)', () => {
  it('lists the most searched, and those that most often found nothing, ties by their words', () => {
    const terms = [
      { terms: 'lawn', searches: 5, foundNothing: 0 },
      { terms: 'khussa', searches: 3, foundNothing: 3 },
      { terms: 'chiffon', searches: 3, foundNothing: 1 },
      ...Array.from({ length: 30 }, (_, index) => ({
        terms: `rare ${String(index).padStart(2, '0')}`,
        searches: 1,
        foundNothing: 0,
      })),
    ];
    const report = storeSearchesOf({ searches: 41, foundNothing: 4, terms }, 30);
    expect(report.top).toHaveLength(SEARCH_REPORT_ROWS);
    expect(report.top.slice(0, 4).map((row) => row.terms)).toEqual([
      'lawn',
      'chiffon',
      'khussa',
      'rare 00',
    ]);
    expect(report.nothingFound.map((row) => [row.terms, row.foundNothing])).toEqual([
      ['khussa', 3],
      ['chiffon', 1],
    ]);
    expect(report.foundNothingRate).toBe(0.0976);
    expect(storeSearchesOf({ searches: 0, foundNothing: 0, terms: [] }, 7)).toMatchObject({
      days: 7,
      foundNothingRate: null,
      top: [],
      nothingFound: [],
    });
  });

  it('counts back the days asked for from today, across a month', () => {
    expect(searchDays('2026-10-02', 3)).toEqual(['2026-10-02', '2026-10-01', '2026-09-30']);
  });
});
