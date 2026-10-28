import type { Money } from './types';

/** "Rs 2,499", as the shop's own pages say rupees; other currencies by their code. */
export function formatMoney(money: Money): string {
  const amount = Number(money.amount);
  const whole = Number.isInteger(amount);
  const number = amount.toLocaleString('en-PK', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return money.currencyCode === 'PKR' ? `Rs ${number}` : `${money.currencyCode} ${number}`;
}
