import { findCity } from '@hatti/pk';

// Couriers' names for cities (SHP-03, ADR-233). A courier delivers to the cities on its own list,
// written its own way: "Rawalpindi" where a customer typed "Pindi", "D.G. Khan" for Dera Ghazi
// Khan. A parcel's city is matched to the list through Pakistan's names for the city and their
// aliases, and staff choose among the nearest names where none matches.

/** A city's name as matched against a courier's: its letters and digits, in lower case. */
export function cityKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The courier's name for `city` from its list `names`: the same name in any case or spacing, else
 * Pakistan's name for the city or one of its aliases ("Pindi" and "RWP" are Rawalpindi), as the
 * list writes it. Null when none is on it.
 */
export function courierNameOf(city: string, names: readonly string[]): string | null {
  const byKey = new Map<string, string>();
  for (const name of names) {
    const key = cityKey(name);
    if (key !== '' && !byKey.has(key)) byKey.set(key, name);
  }
  const direct = byKey.get(cityKey(city));
  if (direct !== undefined) return direct;
  const known = findCity(city);
  if (!known) return null;
  for (const candidate of [known.name, known.id, ...known.aliases]) {
    const found = byKey.get(cityKey(candidate));
    if (found !== undefined) return found;
  }
  return null;
}

/** Names suggested at most. */
export const CITY_SUGGESTIONS = 5;

/**
 * The names on the courier's list `names` nearest to `city`, the nearest first: those it begins
 * or ends, then those a few letters from it, by how few. Pakistan's name for the city is matched
 * as well as what was typed.
 */
export function nearestCityNames(
  city: string,
  names: readonly string[],
  limit = CITY_SUGGESTIONS,
): string[] {
  const typed = [cityKey(city), cityKey(findCity(city)?.name ?? '')].filter((key) => key !== '');
  if (typed.length === 0) return [];
  const ranked: { name: string; rank: number; distance: number }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = cityKey(name);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    let best: { rank: number; distance: number } | null = null;
    for (const each of typed) {
      const rank = key.startsWith(each) || each.startsWith(key) ? 0 : 1;
      const distance = editDistance(each, key);
      // A few letters off for a name of its length: a third of it, two at least.
      if (rank === 1 && distance > Math.max(2, Math.floor(each.length / 3))) continue;
      if (!best || rank < best.rank || (rank === best.rank && distance < best.distance)) {
        best = { rank, distance };
      }
    }
    if (best) ranked.push({ name, ...best });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((each) => each.name);
}

/** How many letters added, taken away or changed make `a` into `b`. */
function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let previous = Array.from({ length: y.length + 1 }, (_, at) => at);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[y.length]!;
}
