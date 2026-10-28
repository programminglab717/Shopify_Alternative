/**
 * FBR's units of measure for digital invoicing (CAT-19, ADR-895), as its reference list names
 * them; an item's unit is sent as written here. "Numbers, pieces, units" is the default.
 */
export const FBR_UNITS = [
  'Numbers, pieces, units',
  'Pair',
  'Dozen',
  'SET',
  'Packs',
  'Bag',
  'KG',
  'Gram',
  'Kilogram',
  'Pound',
  '40KG',
  'MT',
  'Carat',
  'Liter',
  'Gallon',
  'Meter',
  'Foot',
  'SqY',
  'Square Foot',
  'Square Metre',
  'Cubic Metre',
  'Barrels',
  'Thousand Unit',
  'KWH',
  '1000 kWh',
  'Mega Watt',
  'MMBTU',
  'Timber Logs',
  'Bill of lading',
  'Others',
] as const;

export type FbrUnit = (typeof FBR_UNITS)[number];

/** FBR's unit of measure for items not given one. */
export const FBR_DEFAULT_UNIT: FbrUnit = 'Numbers, pieces, units';

/** Whether `unit` is one of FBR's units, as written. */
export function isFbrUnit(unit: string): unit is FbrUnit {
  return (FBR_UNITS as readonly string[]).includes(unit);
}

/** How long an SRO's schedule number and its item's serial number may be. */
export const FBR_SRO_LIMITS = { scheduleNo: 50, itemSerialNo: 20 } as const;
