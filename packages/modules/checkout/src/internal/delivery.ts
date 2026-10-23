import type { InputChecker } from '@hatti/api';
import type { CurrencyCode } from '@hatti/money';
import { addPkWorkingDays, findCity, pkDayOf, pkHourOf } from '@hatti/pk';

/** What a shop charges to deliver an order (ADR-043), in minor units. */
export interface DeliverySettingsRecord {
  /** For everywhere no zone names. */
  charge: bigint;
  /** A subtotal from which delivery is free; null for none. */
  freeAbove: bigint | null;
  /** How many working days delivery takes everywhere (CHK-22, ADR-235); null for unsaid. */
  days: DeliveryDays | null;
  zones: DeliveryZoneRecord[];
  /**
   * The hour, 1 to 23 in Pakistan's time, from which the day's orders count their delivery days
   * from the next day (ADR-597); null or left out for none.
   */
  cutoffHour?: number | null;
  /**
   * What heavier orders cost more to deliver (CHK-04, ADR-702), the lightest first: an order
   * weighing more than one's `aboveGrams` costs its `charge` more, the heaviest it passes alone.
   * Left out for none.
   */
  weights?: DeliveryWeightRecord[];
  /**
   * What larger orders pay at most to deliver (CHK-04, ADR-721), the smallest first: an order of
   * at least one's `fromSubtotal` pays no more than its `charge`, the largest it reaches alone,
   * before what its weight adds. Left out for none.
   */
  valueRates?: DeliveryValueRateRecord[];
  /**
   * Times of the day the shop delivers in (CHK-15, ADR-768), in Pakistan's time, the earliest
   * first: checkout asks the shopper for one. Left out or empty for none.
   */
  slots?: DeliverySlotRecord[];
  /** How many days ahead, today the first, checkout offers slots on: 1 to 14; 7 when left out. */
  slotDays?: number;
  /** How many hours ahead a slot must start to be offered: 0 to 72; 2 when left out. */
  slotLeadHours?: number;
  /**
   * How many orders a slot on a day takes (ADR-772), 1 to 1,000: one that has as many is no
   * longer offered. Null or left out for no limit.
   */
  slotCapacity?: number | null;
  /** Null while the shop has set none. */
  updatedAt: Date | null;
}

/** A time of the day the shop delivers in, "HH:MM" in Pakistan's time, `from` before `until`. */
export interface DeliverySlotRecord {
  from: string;
  until: string;
}

/** A slot on a day, as checkout offers it and an order keeps it (ADR-768). */
export interface OfferedDeliverySlot {
  /** "2026-10-24T10:00-13:00": the day and the slot, which checkout's form sends back. */
  key: string;
  /** The day, YYYY-MM-DD in Pakistan. */
  day: string;
  startsAt: Date;
  endsAt: Date;
}

/** What an order weighing more than `aboveGrams` costs more to deliver, in minor units. */
export interface DeliveryWeightRecord {
  aboveGrams: number;
  charge: bigint;
}

/** What an order of at least `fromSubtotal` pays at most to deliver, in minor units. */
export interface DeliveryValueRateRecord {
  fromSubtotal: bigint;
  charge: bigint;
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
  cutoffHour: null,
  weights: [],
  valueRates: [],
  slots: [],
  slotDays: 7,
  slotLeadHours: 2,
  slotCapacity: null,
  updatedAt: null,
};

export const DELIVERY_LIMITS = {
  zones: 20,
  cities: 200,
  name: 100,
  days: 30,
  weights: 10,
  valueRates: 10,
  /** 1,000 kg: more than any courier takes as a parcel. */
  grams: 1_000_000,
  slots: 8,
  slotDays: 14,
  slotLeadHours: 72,
  slotCapacity: 1000,
} as const;

/** Those left out stay as they are; `zones`, when given, replaces them all. */
export interface DeliverySettingsInput {
  /** Decimal, in major units, such as "250"; null for nothing. */
  charge?: string | null;
  /** Decimal, in major units; null or blank for none. */
  freeAbove?: string | null;
  /** Null for unsaid. */
  days?: DeliveryDays | null;
  zones?: DeliveryZoneInput[] | null;
  /** 1 to 23; null for none. */
  cutoffHour?: number | null;
  /** Replaces them all, in any order; an empty list for none. */
  weights?: DeliveryWeightInput[] | null;
  /** Replaces them all, in any order; an empty list for none. */
  valueRates?: DeliveryValueRateInput[] | null;
  /** Replaces them all, in any order; an empty list for none. */
  slots?: DeliverySlotRecord[] | null;
  /** 1 to 14. */
  slotDays?: number | null;
  /** 0 to 72. */
  slotLeadHours?: number | null;
  /** 1 to 1,000; null for no limit. */
  slotCapacity?: number | null;
}

export interface DeliveryValueRateInput {
  /** Decimal, in major units, more than nothing: "3,000" for orders of Rs 3,000 or more. */
  fromSubtotal: string;
  /** Decimal, in major units; "0" for free. */
  charge: string;
}

export interface DeliveryWeightInput {
  /** Whole grams, more than 0: 2000 for orders over 2 kg. */
  aboveGrams: number;
  /** Decimal, in major units, more than nothing. */
  charge: string;
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
 * free from, else the charge of the zone naming the city, else the charge for everywhere, no more
 * than what an order of `subtotal` pays at most (ADR-721); and what an order of `grams` costs
 * more for its weight (ADR-702).
 */
export function deliveryCharge(
  settings: DeliverySettingsRecord,
  city: string | null,
  subtotal: bigint,
  grams = 0,
): bigint {
  if (settings.freeAbove !== null && subtotal >= settings.freeAbove) return 0n;
  const name = city ? (findCity(city)?.name ?? null) : null;
  const zone = name ? settings.zones.find((each) => each.cities.includes(name)) : undefined;
  return (
    atMost(zone ? zone.charge : settings.charge, valueRateCharge(settings, subtotal)) +
    weightCharge(settings, grams)
  );
}

/**
 * The most an order of `subtotal` pays to deliver (ADR-721): the charge of the largest value rate
 * it reaches; null where it reaches none.
 */
export function valueRateCharge(settings: DeliverySettingsRecord, subtotal: bigint): bigint | null {
  let charge: bigint | null = null;
  for (const rate of settings.valueRates ?? []) {
    if (subtotal >= rate.fromSubtotal) charge = rate.charge;
  }
  return charge;
}

/** `charge`, or `most` where it is less. */
function atMost(charge: bigint, most: bigint | null): bigint {
  return most !== null && most < charge ? most : charge;
}

/**
 * What an order of `grams` costs more to deliver for its weight (ADR-702): the charge of the
 * heaviest weight it is more than, else nothing.
 */
export function weightCharge(settings: DeliverySettingsRecord, grams: number): bigint {
  let charge = 0n;
  for (const weight of settings.weights ?? []) {
    if (grams > weight.aboveGrams) charge = weight.charge;
  }
  return charge;
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
 * The day delivery's working days count from for an order placed at `at` (ADR-597): the day it
 * is in Pakistan, or the next once the shop's cut-off hour has come.
 */
export function deliveryCountsFrom(settings: DeliverySettingsRecord, at: Date): string {
  const today = pkDayOf(at);
  const cutoff = settings.cutoffHour ?? null;
  if (cutoff === null || pkHourOf(at) < cutoff) return today;
  return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The day to expect delivery to `city` by (ADR-594), YYYY-MM-DD: the most of the city's working
 * days counted from `today` past Sundays and Pakistan's public holidays. Null without a city, or
 * days the shop said, or while an item waits on its pre-order, whose day says more.
 */
export function expectedDeliveryOn(
  settings: DeliverySettingsRecord,
  city: string,
  today: string,
  items: readonly { preorderShipsOn?: string | null }[],
): string | null {
  if (city.trim() === '' || items.some((item) => item.preorderShipsOn)) return null;
  const days = deliveryDays(settings, city);
  return days ? addPkWorkingDays(today, days.max) : null;
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
 * The most delivery of `subtotal` of items weighing `grams` may cost, wherever it goes: the
 * dearest of the charge for everywhere and the zones', no more than the subtotal's value rate
 * (ADR-721), with what the weight adds, or nothing from the free threshold.
 */
export function highestDeliveryCharge(
  settings: DeliverySettingsRecord,
  subtotal: bigint,
  grams = 0,
): bigint {
  if (settings.freeAbove !== null && subtotal >= settings.freeAbove) return 0n;
  const highest = settings.zones.reduce(
    (most, zone) => (zone.charge > most ? zone.charge : most),
    settings.charge,
  );
  return atMost(highest, valueRateCharge(settings, subtotal)) + weightCharge(settings, grams);
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
  let cutoffHour = current.cutoffHour ?? null;
  if (input.cutoffHour !== undefined) {
    cutoffHour = input.cutoffHour;
    if (
      cutoffHour !== null &&
      !(Number.isInteger(cutoffHour) && cutoffHour >= 1 && cutoffHour <= 23)
    ) {
      check.addMessage(['cutoffHour'], 'INVALID', 'The cut-off is an hour from 1 to 23');
    }
  }
  let weights = current.weights ?? [];
  if (input.weights !== undefined) {
    weights = checkWeights(check, input.weights ?? [], currency);
  }
  let valueRates = current.valueRates ?? [];
  if (input.valueRates !== undefined) {
    valueRates = checkValueRates(check, input.valueRates ?? [], currency);
  }
  let slots = current.slots ?? [];
  if (input.slots !== undefined) slots = checkSlots(check, input.slots ?? []);
  const slotDays = checkWhole(check, 'slotDays', input.slotDays, current.slotDays ?? 7, {
    min: 1,
    max: DELIVERY_LIMITS.slotDays,
    message: `Slots are offered 1 to ${DELIVERY_LIMITS.slotDays} days ahead`,
  });
  const slotLeadHours = checkWhole(
    check,
    'slotLeadHours',
    input.slotLeadHours,
    current.slotLeadHours ?? 2,
    {
      min: 0,
      max: DELIVERY_LIMITS.slotLeadHours,
      message: `A slot starts 0 to ${DELIVERY_LIMITS.slotLeadHours} hours ahead`,
    },
  );
  let slotCapacity = current.slotCapacity ?? null;
  if (input.slotCapacity !== undefined) {
    slotCapacity = input.slotCapacity;
    if (
      slotCapacity !== null &&
      !(
        Number.isInteger(slotCapacity) &&
        slotCapacity >= 1 &&
        slotCapacity <= DELIVERY_LIMITS.slotCapacity
      )
    ) {
      check.addMessage(
        ['slotCapacity'],
        'INVALID',
        `A slot takes 1 to ${DELIVERY_LIMITS.slotCapacity} orders, or no limit`,
      );
    }
  }
  return check.errors.length > before
    ? null
    : {
        charge,
        freeAbove,
        days,
        zones,
        cutoffHour,
        weights,
        valueRates,
        slots,
        slotDays,
        slotLeadHours,
        slotCapacity,
      };
}

/** `input` where given and whole from `min` to `max`, else `current`, adding what is wrong. */
function checkWhole(
  check: InputChecker,
  field: string,
  input: number | null | undefined,
  current: number,
  limits: { min: number; max: number; message: string },
): number {
  if (input === undefined || input === null) return current;
  if (!Number.isInteger(input) || input < limits.min || input > limits.max) {
    check.addMessage([field], 'INVALID', limits.message);
    return current;
  }
  return input;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Times of the day as "HH:MM", 00:00 to 23:59, each ending after it starts, none overlapping
 * another, kept the earliest first; at most {@link DELIVERY_LIMITS.slots}.
 */
function checkSlots(check: InputChecker, inputs: readonly DeliverySlotRecord[]) {
  if (inputs.length > DELIVERY_LIMITS.slots) {
    check.addMessage(
      ['slots'],
      'INVALID',
      `A shop offers at most ${DELIVERY_LIMITS.slots} delivery slots`,
    );
    return [];
  }
  const slots = inputs.map((input, index) => {
    const at = ['slots', String(index)];
    const from = input.from.trim();
    const until = input.until.trim();
    if (!CLOCK.test(from)) {
      check.addMessage([...at, 'from'], 'INVALID', 'A time is HH:MM, from 00:00 to 23:59');
    }
    if (!CLOCK.test(until)) {
      check.addMessage([...at, 'until'], 'INVALID', 'A time is HH:MM, from 00:00 to 23:59');
    } else if (CLOCK.test(from) && until <= from) {
      check.addMessage([...at, 'until'], 'INVALID', 'A slot must end after it starts');
    }
    return { from, until, index };
  });
  const sorted = [...slots].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  sorted.forEach((slot, place) => {
    const next = sorted[place + 1];
    if (next && next.from < slot.until && CLOCK.test(next.from) && CLOCK.test(slot.until)) {
      check.addMessage(
        ['slots', String(next.index), 'from'],
        'INVALID',
        `This slot overlaps ${slot.from} to ${slot.until}`,
      );
    }
  });
  return sorted.map(({ from, until }) => ({ from, until }));
}

/**
 * The slots checkout offers at `now` (ADR-768): each of the shop's slots on each of its slot days
 * from today in Pakistan, those starting at least its lead hours from now. None without slots.
 */
export function offeredSlots(settings: DeliverySettingsRecord, now: Date): OfferedDeliverySlot[] {
  const slots = settings.slots ?? [];
  if (slots.length === 0) return [];
  const earliest = now.getTime() + (settings.slotLeadHours ?? 2) * 3_600_000;
  const today = Date.parse(`${pkDayOf(now)}T00:00:00Z`);
  const offered: OfferedDeliverySlot[] = [];
  for (let ahead = 0; ahead < (settings.slotDays ?? 7); ahead++) {
    const day = new Date(today + ahead * 86_400_000).toISOString().slice(0, 10);
    for (const slot of slots) {
      const startsAt = pkTime(day, slot.from);
      if (startsAt.getTime() < earliest) continue;
      offered.push({
        key: slotKey(day, slot),
        day,
        startsAt,
        endsAt: pkTime(day, slot.until),
      });
    }
  }
  return offered;
}

/**
 * The slots of `offered` with room for another order (ADR-772): those with fewer orders than the
 * shop's slots take, by `taken`, the orders each has by when it starts, in ms; all without a limit.
 */
export function slotsWithRoom(
  settings: DeliverySettingsRecord,
  offered: readonly OfferedDeliverySlot[],
  taken: ReadonlyMap<number, number>,
): OfferedDeliverySlot[] {
  const capacity = settings.slotCapacity ?? null;
  if (capacity === null) return [...offered];
  return offered.filter((slot) => (taken.get(slot.startsAt.getTime()) ?? 0) < capacity);
}

/** The offered slot `key` names, or null where it is not offered at `now`. */
export function offeredSlot(
  settings: DeliverySettingsRecord,
  key: string,
  now: Date,
): OfferedDeliverySlot | null {
  return offeredSlots(settings, now).find((slot) => slot.key === key) ?? null;
}

function slotKey(day: string, slot: DeliverySlotRecord): string {
  return `${day}T${slot.from}-${slot.until}`;
}

/** `clock` ("HH:MM") on `day` in Pakistan, which keeps UTC+5 all year. */
function pkTime(day: string, clock: string): Date {
  return new Date(`${day}T${clock}:00+05:00`);
}

/** Subtotals above nothing, each once, kept the smallest first; charges of nothing or more. */
function checkValueRates(
  check: InputChecker,
  inputs: readonly DeliveryValueRateInput[],
  currency: CurrencyCode,
): DeliveryValueRateRecord[] {
  if (inputs.length > DELIVERY_LIMITS.valueRates) {
    check.addMessage(
      ['valueRates'],
      'INVALID',
      `A shop sets at most ${DELIVERY_LIMITS.valueRates} rates by the order's value`,
    );
    return [];
  }
  const seen = new Set<bigint>();
  const rates = inputs.map((input, index) => {
    const at = ['valueRates', String(index)];
    const from = check.price([...at, 'fromSubtotal'], input.fromSubtotal, currency, {
      required: true,
    });
    if (from === 0n) {
      check.addMessage([...at, 'fromSubtotal'], 'INVALID', 'A rate must start above Rs 0');
    } else if (from !== null && seen.has(from)) {
      check.addMessage([...at, 'fromSubtotal'], 'TAKEN', 'This value has a rate already');
    }
    if (from !== null) seen.add(from);
    const charge = check.price([...at, 'charge'], input.charge, currency, { required: true });
    return { fromSubtotal: from ?? 0n, charge: charge ?? 0n };
  });
  return rates.sort((a, b) =>
    a.fromSubtotal < b.fromSubtotal ? -1 : a.fromSubtotal > b.fromSubtotal ? 1 : 0,
  );
}

/** Whole grams up to {@link DELIVERY_LIMITS.grams}, each once, kept the lightest first. */
function checkWeights(
  check: InputChecker,
  inputs: readonly DeliveryWeightInput[],
  currency: CurrencyCode,
): DeliveryWeightRecord[] {
  if (inputs.length > DELIVERY_LIMITS.weights) {
    check.addMessage(
      ['weights'],
      'INVALID',
      `A shop charges for at most ${DELIVERY_LIMITS.weights} weights`,
    );
    return [];
  }
  const seen = new Set<number>();
  const weights = inputs.map((input, index) => {
    const at = ['weights', String(index)];
    const grams = input.aboveGrams;
    if (!Number.isInteger(grams) || grams < 1 || grams > DELIVERY_LIMITS.grams) {
      check.addMessage(
        [...at, 'aboveGrams'],
        'INVALID',
        `A weight is whole grams from 1 to ${DELIVERY_LIMITS.grams}`,
      );
    } else if (seen.has(grams)) {
      check.addMessage([...at, 'aboveGrams'], 'TAKEN', 'This weight has a charge already');
    }
    seen.add(grams);
    const charge = check.price([...at, 'charge'], input.charge, currency, { required: true });
    if (charge === 0n) {
      check.addMessage([...at, 'charge'], 'INVALID', 'A heavier order must cost more than Rs 0');
    }
    return { aboveGrams: grams, charge: charge ?? 0n };
  });
  return weights.sort((a, b) => a.aboveGrams - b.aboveGrams);
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
