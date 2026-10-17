import { describe, expect, it } from 'vitest';
import { COMMERCE_LEXICON, searchKey, synonymsOf } from './index.js';

describe('commerce lexicon (ADR-481)', () => {
  it('gives the words that mean the same in English, Roman Urdu and Urdu, folded', () => {
    expect(synonymsOf(searchKey('juta'))).toEqual(
      expect.arrayContaining(['shoe', 'shoes', searchKey('جوتا')]),
    );
    // However it is spelled: qameez and kameez fold together, and find the Urdu.
    expect(synonymsOf(searchKey('Qameez'))).toEqual([searchKey('قمیض')]);
    expect(synonymsOf(searchKey('قمیض'))).toEqual(['kamiz']);
    // An Urdu word typed on an Arabic keyboard finds it too.
    expect(synonymsOf(searchKey('دوپٹه'))).toContain('dupata');
    // Never itself, and nothing for a word it doesn't know.
    expect(synonymsOf('shoes')).not.toContain('shoes');
    expect(synonymsOf('palazzo')).toEqual([]);
  });

  it('keeps a kind of a thing apart from the thing', () => {
    expect(synonymsOf('shoes')).not.toContain('khusa');
    expect(synonymsOf(searchKey('kurta'))).not.toContain(searchKey('kurti'));
  });

  it('puts each word in one meaning alone', () => {
    const seen = new Map<string, number>();
    COMMERCE_LEXICON.forEach((group, at) => {
      for (const word of group) {
        const key = searchKey(word);
        expect(key, word).not.toBe('');
        expect(key.includes(' '), word).toBe(false);
        if (seen.has(key)) expect(seen.get(key), `${word} is in two groups`).toBe(at);
        seen.set(key, at);
      }
    });
  });
});
