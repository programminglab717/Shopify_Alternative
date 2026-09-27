import { CURRENCIES, exponentOf } from './currency.js';
import { money, type Money } from './money.js';
import { divideRounded } from './rounding.js';

export interface FormatOptions {
  /** "international" → 1,250,000 · "south-asian" (lakh/crore) → 12,50,000 */
  grouping?: 'international' | 'south-asian';
  /** "auto" shows paisa only when non-zero; "never" rounds to whole units (half-up). */
  decimals?: 'auto' | 'always' | 'never';
  /** "symbol" → Rs 12,500 · "code" → PKR 12,500 · "none" → 12,500 */
  display?: 'symbol' | 'code' | 'none';
}

function groupDigits(digits: string, grouping: 'international' | 'south-asian'): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const size = grouping === 'south-asian' ? 2 : 3;
  const groups: string[] = [];
  for (let end = rest.length; end > 0; end -= size) {
    groups.unshift(rest.slice(Math.max(0, end - size), end));
  }
  return `${groups.join(',')},${lastThree}`;
}

/** Formats money for people: "Rs 12,500", "Rs 1,25,000", "-Rs 99.50". */
export function formatMoney(m: Money, options: FormatOptions = {}): string {
  const { grouping = 'international', decimals = 'auto', display = 'symbol' } = options;
  const exponent = exponentOf(m.currency);
  const scale = 10n ** BigInt(exponent);

  let amount = m;
  if (decimals === 'never' && exponent > 0) {
    amount = money(divideRounded(m.amount, scale, 'half-up') * scale, m.currency);
  }
  const negative = amount.amount < 0n;
  const absolute = negative ? -amount.amount : amount.amount;
  const whole = (absolute / scale).toString();
  const fraction = (absolute % scale).toString().padStart(exponent, '0');
  const showFraction =
    exponent > 0 && (decimals === 'always' || (decimals === 'auto' && absolute % scale !== 0n));

  const number = `${groupDigits(whole, grouping)}${showFraction ? `.${fraction}` : ''}`;
  const label =
    display === 'symbol' ? CURRENCIES[m.currency].symbol : display === 'code' ? m.currency : '';
  const body = label ? `${label} ${number}` : number;
  return negative ? `-${body}` : body;
}
