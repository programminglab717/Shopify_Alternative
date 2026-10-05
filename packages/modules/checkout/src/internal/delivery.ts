import type { InputChecker } from '@hatti/api';
import type { CurrencyCode } from '@hatti/money';
import { findCity } from '@hatti/pk';

/** What a shop charges to deliver an order (ADR-043), in minor units. */
export interface DeliverySettingsRecord {
  /** For everywhere no zone names. */
  charge: bigint;
  /** A subtotal from which delivery is free; null for none. */
  freeAbove: bigint | null;
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
}

/** What a shop that has set nothing charges: nothing. */
export const NO_DELIVERY_SETTINGS: DeliverySettingsRecord = {
  charge: 0n,
  freeAbove: null,
  zones: [],
  updatedAt: null,
};

export const DELIVERY_LIMITS = { zones: 20, cities: 200, name: 100 } as const;

/** Those left out stay as they are; `zones`, when given, replaces them all. */
export interface DeliverySettingsInput {
  /** Decimal, in major units, such as "250"; null for nothing. */
  charge?: string | null;
  /** Decimal, in major units; null or blank for none. */
  freeAbove?: string | null;
  zones?: DeliveryZoneInput[] | null;
}

export interface DeliveryZoneInput {
  name: string;
  /** Cities by name, alias or code, as addresses have them: "khi", "Pindi". */
  cities: string[];
  /** Decimal, in major units. */
  charge: string;
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
  let zones = current.zones;
  if (input.zones !== undefined && input.zones !== null) {
    zones = checkZones(check, input.zones, currency);
  }
  return check.errors.length > before ? null : { charge, freeAbove, zones };
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
    return { name, cities, charge: charge ?? 0n };
  });
}
