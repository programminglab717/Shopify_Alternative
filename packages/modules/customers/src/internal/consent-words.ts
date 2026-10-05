import type { MarketingChannelValue } from './schema.js';

/**
 * The words a shop's pages put beside consent to its news and offers on `channel`, in English and
 * Urdu, naming the shop: checkout's boxes (ADR-187) and the storefront's sign-up form (ADR-189)
 * show them, and the consent ledger keeps them.
 */
export function marketingWords(
  shopName: string,
  channel: MarketingChannelValue,
): { en: string; ur: string } {
  switch (channel) {
    case 'whatsapp':
      return {
        en: `Send me news and offers from ${shopName} on WhatsApp`,
        ur: `مجھے ${shopName} کی خبریں اور آفرز واٹس ایپ پر بھیجیں`,
      };
    case 'sms':
      return {
        en: `Text me with news and offers from ${shopName}`,
        ur: `مجھے ${shopName} کی خبریں اور آفرز ایس ایم ایس پر بھیجیں`,
      };
    case 'email':
      return {
        en: `Email me with news and offers from ${shopName}`,
        ur: `مجھے ${shopName} کی خبریں اور آفرز ای میل پر بھیجیں`,
      };
  }
}

/** A channel's words as its consent keeps them: the English, then the Urdu, as pages show. */
export function marketingWording(shopName: string, channel: MarketingChannelValue): string {
  const words = marketingWords(shopName, channel);
  return `${words.en}\n${words.ur}`;
}
