import type { InputChecker } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { parsePkMobile } from '@hatti/pk';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { LIMITS, displayPhone } from './rules.js';
import { customerPhones } from './schema.js';

/**
 * A customer's other numbers, checked: each a Pakistani mobile, none twice and none the main
 * number, in E.164 form. Undefined when left out; null clears them.
 */
export function checkOtherPhones(
  check: InputChecker,
  field: string[],
  values: readonly string[] | null | undefined,
  main: string | null,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (values === null) return [];
  if (values.length > LIMITS.otherPhones) {
    check.add(field, 'TOO_MANY', `can have at most ${LIMITS.otherPhones}`);
    return [];
  }
  const phones: string[] = [];
  values.forEach((value, index) => {
    const at = [...field, String(index)];
    const mobile = parsePkMobile(value.trim());
    if (!mobile) {
      check.addMessage(at, 'INVALID', `"${value.slice(0, 32)}" is not a Pakistani mobile number`);
    } else if (mobile.e164 === main) {
      check.addMessage(at, 'INVALID', `${displayPhone(mobile.e164)} is their main number`);
    } else if (phones.includes(mobile.e164)) {
      check.addMessage(at, 'INVALID', `${displayPhone(mobile.e164)} is listed twice`);
    } else {
      phones.push(mobile.e164);
    }
  });
  return phones;
}

/** Whose each of these numbers is, for those that are someone's. */
export async function ownersOf(
  tx: Tx,
  shopId: string,
  phones: readonly string[],
): Promise<Map<string, string>> {
  if (phones.length === 0) return new Map();
  const rows = await tx
    .select({ phone: customerPhones.phone, customerId: customerPhones.customerId })
    .from(customerPhones)
    .where(and(eq(customerPhones.shopId, shopId), inArray(customerPhones.phone, [...phones])));
  return new Map(rows.map((row) => [row.phone, row.customerId]));
}

/** Every number of each customer, the main one included, oldest first. */
export async function numbersOf(
  tx: Tx,
  shopId: string,
  customerIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (customerIds.length === 0) return new Map();
  const rows = await tx
    .select({ phone: customerPhones.phone, customerId: customerPhones.customerId })
    .from(customerPhones)
    .where(
      and(eq(customerPhones.shopId, shopId), inArray(customerPhones.customerId, [...customerIds])),
    )
    .orderBy(asc(customerPhones.createdAt), asc(customerPhones.phone));
  const numbers = new Map<string, string[]>();
  for (const row of rows) {
    const list = numbers.get(row.customerId) ?? [];
    list.push(row.phone);
    numbers.set(row.customerId, list);
  }
  return numbers;
}
