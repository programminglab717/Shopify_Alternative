import { normalizeDigits } from './text.js';

/** A point on the map in decimal degrees: north of the equator and east of Greenwich. */
export interface MapPoint {
  latitude: number;
  longitude: number;
}

/**
 * The box Pakistan lies in, a little wider than its borders: from its coast on the Arabian Sea,
 * near 23.6° north, to the Khunjerab Pass, near 37.1°; and from the Iranian border, near 60.9°
 * east, to Kashmir, near 77.8°.
 */
export const PK_BOUNDS = Object.freeze({ south: 23.5, north: 37.5, west: 60.5, east: 78 });

/**
 * Whether `point` lies in Pakistan's box ({@link PK_BOUNDS}). A point just over a border lies in
 * it too: an address's city says which country it is in.
 */
export function inPakistan(point: MapPoint): boolean {
  return (
    point.latitude >= PK_BOUNDS.south &&
    point.latitude <= PK_BOUNDS.north &&
    point.longitude >= PK_BOUNDS.west &&
    point.longitude <= PK_BOUNDS.east
  );
}

/**
 * Degrees as a phone's browser or an API gives them, "24.860700" or 24.8607, to six places:
 * about a tenth of a metre, finer than any phone finds. Null for anything but a decimal number.
 */
export function parseDegrees(value: string | number): number | null {
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? String(value)
        : ''
      : normalizeDigits(value.trim());
  if (!/^-?\d{1,3}(?:\.\d{1,15})?$/.test(text)) return null;
  return Math.round(Number(text) * 1e6) / 1e6;
}

/**
 * How far from a city's centre its addresses' pins may lie: Karachi's furthest suburbs, such as
 * DHA City, lie some 60 km out. A pin further away was added somewhere else.
 */
export const CITY_REACH_KM = 80;

/** How far apart two points are along the earth's surface, in kilometres. */
export function distanceKm(a: MapPoint, b: MapPoint): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const across = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2;
  const along =
    Math.cos(radians(a.latitude)) *
    Math.cos(radians(b.latitude)) *
    Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(across + along));
}
