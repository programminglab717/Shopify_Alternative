import type { InputChecker } from '@hatti/api';
import { MARKETING_CHANNELS, type MarketingChannelValue } from '@hatti/customers/public';

// The words beside each box are the customers module's, which the consent ledger keeps.
export { marketingWording, marketingWords } from '@hatti/customers/public';

/** What a checkout offers when its shop chose nothing: a box for WhatsApp alone (ADR-187). */
export const DEFAULT_MARKETING_CHANNELS: readonly MarketingChannelValue[] = ['whatsapp'];

/** The form's field for each channel's box, "1" when ticked. */
export const MARKETING_FIELDS = {
  whatsapp: 'marketingWhatsapp',
  sms: 'marketingSms',
  email: 'marketingEmail',
} as const satisfies Record<MarketingChannelValue, string>;

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
