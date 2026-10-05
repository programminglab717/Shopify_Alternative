import type { InputChecker } from '@hatti/api';
import { MARKETING_CHANNELS, type MarketingChannelValue } from '@hatti/customers/public';

/** What a checkout offers when its shop chose nothing: a box for WhatsApp alone (ADR-187). */
export const DEFAULT_MARKETING_CHANNELS: readonly MarketingChannelValue[] = ['whatsapp'];

/** The form's field for each channel's box, "1" when ticked. */
export const MARKETING_FIELDS = {
  whatsapp: 'marketingWhatsapp',
  sms: 'marketingSms',
  email: 'marketingEmail',
} as const satisfies Record<MarketingChannelValue, string>;

/**
 * The words beside a channel's box, in English and Urdu, naming the shop: as the page shows them,
 * and as the customer's consent keeps them.
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

/** A channel's words as its consent keeps them: the English, then the Urdu, as the page shows. */
export function marketingWording(shopName: string, channel: MarketingChannelValue): string {
  const words = marketingWords(shopName, channel);
  return `${words.en}\n${words.ur}`;
}

/** The channels whose box is ticked in `marketing`, the form's list, of those `offered`. */
export function marketingTicked(
  marketing: string | undefined,
  offered: readonly MarketingChannelValue[],
): MarketingChannelValue[] {
  const ticked = new Set((marketing ?? '').split(' '));
  return offered.filter((channel) => ticked.has(channel));
}

/**
 * The channels a shop's checkout is to offer, each once, in the page's order; null when they do
 * not pass, with the errors added to `check`.
 */
export function checkMarketingChannels(
  check: InputChecker,
  field: string[],
  channels: readonly MarketingChannelValue[],
): MarketingChannelValue[] | null {
  const seen = new Set<MarketingChannelValue>();
  channels.forEach((channel, index) => {
    if (seen.has(channel)) {
      check.addMessage([...field, String(index)], 'INVALID', 'The same channel is listed twice');
    }
    seen.add(channel);
  });
  return check.ok ? MARKETING_CHANNELS.filter((channel) => seen.has(channel)) : null;
}
