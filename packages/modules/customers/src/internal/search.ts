import { normalizeDigits, parsePkMobile, searchKey } from '@hatti/pk';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { customerPhones, customers } from './schema.js';

/**
 * How a search matches mobile numbers: a whole number in any format matches exactly, and four or
 * more digits match anywhere in it, so staff can find someone by the end of their number. Null
 * when the query is not a number. Staff who see numbers masked search by whole numbers only
 * (`partial: false`): matching digits anywhere would let them rebuild a number digit by digit.
 */
export function phoneMatch(
  column: AnyColumn,
  query: string,
  options: { partial: boolean },
): SQL | null {
  const mobile = parsePkMobile(query);
  if (mobile) return sql`${column} = ${mobile.e164}`;
  const digits = normalizeDigits(query).replace(/[\s\-().+]/g, '');
  if (!/^\d{4,}$/.test(digits)) return null;
  if (!options.partial) return sql`false`;
  // Stored numbers are E.164, "+923001234567": drop a leading 0 of the national form.
  return sql`${column} LIKE ${`%${digits.replace(/^0/, '')}%`}`;
}

/**
 * A customer search: one of their numbers, main or other, or words that must all appear in the
 * name or email.
 */
export function customerMatch(query: string, options: { partial: boolean }): SQL {
  const byPhone = phoneMatch(customerPhones.phone, query, options);
  if (byPhone) {
    return sql`EXISTS (SELECT 1 FROM ${customerPhones}
                        WHERE ${customerPhones.shopId} = ${customers.shopId}
                          AND ${customerPhones.customerId} = ${customers.id} AND ${byPhone})`;
  }
  // Tokens hold only letters and digits, so no LIKE escaping.
  const words = searchKey(query)
    .split(' ')
    .filter(Boolean)
    .map((token) => sql`${customers.searchText} LIKE ${`%${token}%`}`);
  return words.length > 0 ? sql`(${sql.join(words, sql` AND `)})` : sql`false`;
}
