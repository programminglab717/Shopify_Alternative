import type { InputChecker } from '@hatti/api';
import type { CurrencyCode } from '@hatti/money';
import { findCity } from '@hatti/pk';

/** What a shop charges to deliver an order (ADR-043), in minor units. */
export interface DeliverySettingsRecord {
  /** For everywhere no zone names. */
  charge: bigint;
  /** A subtotal from which delivery is free; null for none. */
  freeAbove: bigint | null;
  /** How many working days delivery takes everywhere (CHK-22, ADR-235); null for unsaid. */
  days: DeliveryDays | null;
  zones: DeliveryZoneRecord[];
  /** Null while the shop has set none. */
  updatedAt: Date | null;
}

/** Cities with a charge of their own, such as the shop's own city. */
export interface DeliveryZoneRecord {
  name: string;
  /** As `@hatti/pk` spells them: "Karachi", "Rawalpindi". */
  cities: string[];
  charge: bigint;
  /** Its own working days, as the shop's own city's may be fewer; null for everywhere's. */
  days: DeliveryDays | null;
}

/** How many working days delivery takes: from `min` to `max`, 0 the same day. */
export interface DeliveryDays {
  min: number;
  max: number;
}

/** What a shop that has set nothing charges: nothing. */
export const NO_DELIVERY_SETTINGS: DeliverySettingsRecord = {
  charge: 0n,
  freeAbove: null,
  days: null,
  zones: [],
  updatedAt: null,
};

export const DELIVERY_LIMITS = { zones: 20, cities: 200, name: 100, days: 30 } as const;

/** Those left out stay as they are; `zones`, when given, replaces them all. */
export interface DeliverySettingsInput {
  /** Decimal, in major units, such as "250"; null for nothing. */
  charge?: string | null;
  /** Decimal, in major units; null or blank for none. */
  freeAbove?: string | null;
  /** Null for unsaid. */
  days?: DeliveryDays | null;
  zones?: DeliveryZoneInput[] | null;
}

export interface DeliveryZoneInput {
  name: string;
  /** Cities by name, alias or code, as addresses have them: "khi", "Pindi". */
  cities: string[];
  /** Decimal, in major units. */
  charge: string;
  /** Null or left out for everywhere's. */
  days?: DeliveryDays | null;
}

/**
 * The charge to deliver an order with `subtotal` to `city`: nothing from the subtotal delivery is
 * free from, else the charge of the zone naming the city, else the charge for everywhere.
 */
export function deliveryCharge(
  settings: DeliverySettingsRecord,
  city: string | null,
  subtotal: bigint,
): bigint {
  if (settings.freeAbove !== null && subtotal >= settings.freeAbove) return 0n;
  const name = city ? (findCity(city)?.name ?? null) : null;
  const zone = name ? settings.zones.find((each) => each.cities.includes(name)) : undefined;
  return zone ? zone.charge : settings.charge;
}

/**
 * How many working days delivery to `city` takes (ADR-235): the days of the zone naming it, else
 * everywhere's. Without a city, how long it takes wherever it goes ({@link deliveryDaysRange}).
 * Null where the shop has not said.
 */
export function deliveryDays(
  settings: DeliverySettingsRecord,
  city: string | null,
): DeliveryDays | null {
  const name = city ? (findCity(city)?.name ?? null) : null;
  if (!name) return city ? settings.days : deliveryDaysRange(settings);
  const zone = settings.zones.find((each) => each.cities.includes(name));
  return zone?.days ?? settings.days;
}

/**
 * How many working days delivery takes wherever it goes: from the fewest to the most of
 * everywhere's and the zones'. Null unless the shop said how long it takes everywhere, as a
 * city no zone names would have no days.
 */
export function deliveryDaysRange(settings: DeliverySettingsRecord): DeliveryDays | null {
  if (!settings.days) return null;
  let { min, max } = settings.days;
  for (const zone of settings.zones) {
    if (!zone.days) continue;
    min = Math.min(min, zone.days.min);
    max = Math.max(max, zone.days.max);
  }
  return { min, max };
}

/**
 * The most delivery of `subtotal` of items may cost, wherever it goes: the dearest of the charge
 * for everywhere and the zones', or nothing from the free threshold.
 */
export function highestDeliveryCharge(settings: DeliverySettingsRecord, subtotal: bigint): bigint {
  if (settings.freeAbove !== null && subtotal >= settings.freeAbove) return 0n;
  return settings.zones.reduce(
    (highest, zone) => (zone.charge > highest ? zone.charge : highest),
    settings.charge,
  );
}

/**
 * The settings `input` makes of `current`, or null after adding what is wrong to `check`. Cities
 * are the ones addresses name, each in one zone at most.
 */
export function checkDeliverySettings(
  check: InputChecker,
  current: DeliverySettingsRecord,
  input: DeliverySettingsInput,
  currency: CurrencyCode,
): Omit<DeliverySettingsRecord, 'updatedAt'> | null {
  const before = check.errors.length;
  let charge = current.charge;
  if (input.charge !== undefined) charge = check.price(['charge'], input.charge, currency) ?? 0n;
  let freeAbove = current.freeAbove;
  if (input.freeAbove !== undefined) {
    freeAbove = check.price(['freeAbove'], input.freeAbove, currency);
    if (freeAbove === 0n) {
      check.addMessage(['freeAbove'], 'INVALID', 'Free delivery must start above Rs 0');
    }
  }
  let days = current.days;
  if (input.days !== undefined) days = input.days && checkDays(check, ['days'], input.days);
  let zones = current.zones;
  if (input.zones !== undefined && input.zones !== null) {
    zones = checkZones(check, input.zones, currency);
  }
  return check.errors.length > before ? null : { charge, freeAbove, days, zones };
}

/** Whole working days, 0 to {@link DELIVERY_LIMITS.days}, the fewest first. */
function checkDays(check: InputChecker, at: string[], days: DeliveryDays): DeliveryDays {
  for (const key of ['min', 'max'] as const) {
    const value = days[key];
    if (!Number.isInteger(value) || value < 0 || value > DELIVERY_LIMITS.days) {
      check.addMessage(
        [...at, key],
        'INVALID',
        `Delivery takes 0 to ${DELIVERY_LIMITS.days} working days`,
      );
    }
  }
  if (days.max < days.min) {
    check.addMessage(
      [...at, 'max'],
      'INVALID',
      'The most days delivery takes must be no fewer than the fewest',
    );
  }
  return { min: days.min, max: days.max };
}

function checkZones(
  check: InputChecker,
  inputs: readonly DeliveryZoneInput[],
  currency: CurrencyCode,
): DeliveryZoneRecord[] {
  if (inputs.length > DELIVERY_LIMITS.zones) {
    check.addMessage(['zones'], 'INVALID', `A shop has at most ${DELIVERY_LIMITS.zones} zones`);
    return [];
  }
  const zoneOf = new Map<string, string>();
  return inputs.map((input, index) => {
    const at = ['zones', String(index)];
    const name =
      check.text([...at, 'name'], input.name, { required: true, max: DELIVERY_LIMITS.name }) ?? '';
    const charge = check.price([...at, 'charge'], input.charge, currency, { required: true });
    const cities: string[] = [];
    if (input.cities.length === 0 || input.cities.length > DELIVERY_LIMITS.cities) {
      check.addMessage(
        [...at, 'cities'],
        'INVALID',
        `A zone has 1 to ${DELIVERY_LIMITS.cities} cities`,
      );
    }
    input.cities.forEach((text, place) => {
      const city = findCity(text);
      const field = [...at, 'cities', String(place)];
      if (!city) {
        check.addMessage(field, 'INVALID', `"${text.trim()}" is not a city of Pakistan we know`);
      } else if (zoneOf.has(city.name)) {
        check.addMessage(field, 'TAKEN', `${city.name} is in the zone "${zoneOf.get(city.name)}"`);
      } else {
        zoneOf.set(city.name, name);
        cities.push(city.name);
      }
    });
    const days = input.days ? checkDays(check, [...at, 'days'], input.days) : null;
    return { name, cities, charge: charge ?? 0n, days };
  });
}
