import { describe, expect, it } from 'vitest';
import { ASKED_PRODUCTS, askedWordsOf } from './asked-products.js';

describe("The words a customer's message may name a product by (MSG-07, ADR-911)", () => {
  it('keeps the words of what is sold, as product search keys them, each once', () => {
    expect(askedWordsOf('Kya ye Khaddar kameez M size mein hai? Price kya hai? kameez')).toEqual([
      'khadar',
      'kamiz',
    ]);
    expect(askedWordsOf('کیا یہ کرتا میں ہے؟')).toEqual(['کرتا']);
  });

  it('finds nothing in what any message says, numbers or greetings', () => {
    expect(askedWordsOf('Assalam o alaikum, order #1023 kahan hai? please')).toEqual([]);
    expect(askedWordsOf('')).toEqual([]);
  });

  it(`reads ${ASKED_PRODUCTS.words} words at most`, () => {
    const words = Array.from({ length: 20 }, (_, at) => `word${String.fromCharCode(97 + at)}`);
    expect(askedWordsOf(words.join(' '))).toHaveLength(ASKED_PRODUCTS.words);
  });
});
