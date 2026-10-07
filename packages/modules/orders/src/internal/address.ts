import type { InputChecker } from '@hatti/api';
import {
  CITY_REACH_KM,
  distanceKm,
  findCity,
  findProvince,
  inPakistan,
  normalizeDigits,
  parseDegrees,
  type MapPoint,
  type PkCity,
} from '@hatti/pk';
import { LIMITS } from './rules.js';
import type { AddressValue } from './schema.js';

export interface AddressInput {
  /** Who receives the parcel. */
  name: string;
  /** Mobile number, in any common format; couriers call it before delivering. */
  phone: string;
  /** The house and street: "House 12, Street 4, Block 5". */
  address1: string;
  /** The area: "Gulshan-e-Iqbal". */
  address2?: string | null;
  /** A place near it the rider can ask for: "near Jamia Masjid". */
  landmark?: string | null;
  /** Known cities are spelled the standard way: "khi" becomes "Karachi". */
  city: string;
  /** Code ("SD"), name ("Sindh") or alias ("KPK"). From the city when left out. */
  province?: string | null;
  /** Five-digit postcode. */
  zip?: string | null;
  /**
   * Where the address is on the map, in decimal degrees, as the customer's phone found it there
   * (ADR-259): with `longitude`, or neither.
   */
  latitude?: number | string | null;
  longitude?: number | string | null;
}

/** Checks a shipping address; returns it cleaned up, or null after adding errors. */
export function checkAddress(
  check: InputChecker,
  field: string[],
  input: AddressInput,
): AddressValue | null {
  const errorsBefore = check.errors.length;
  const max = LIMITS.addressLine;
  const name = check.text([...field, 'name'], input.name, { required: true, max: LIMITS.name });

  const phone = check.mobile([...field, 'phone'], input.phone, { required: true });

  const address1 = check.text([...field, 'address1'], input.address1, { required: true, max });
  const address2 = check.text([...field, 'address2'], input.address2, { max });
  const landmark = check.text([...field, 'landmark'], input.landmark, { max });
  const cityText = check.text([...field, 'city'], input.city, { required: true, max });
  const city = cityText ? findCity(cityText) : null;

  const provinceText = input.province?.trim() ?? '';
  let provinceCode: string | null = city?.province ?? null;
  if (provinceText !== '') {
    provinceCode = findProvince(provinceText);
    if (!provinceCode) {
      check.add(
        [...field, 'province'],
        'INVALID',
        'must be a province or territory of Pakistan, like Punjab or KPK',
      );
    }
  }

  const zipText = normalizeDigits(input.zip?.trim() ?? '');
  if (zipText !== '' && !/^[0-9]{5}$/.test(zipText)) {
    check.add([...field, 'zip'], 'INVALID', 'must be a five-digit postcode, like 54000');
  }

  const location = checkLocation(check, field, input, city);

  if (check.errors.length > errorsBefore || !name || !phone || !address1 || !cityText) return null;
  return {
    name,
    phone,
    address1,
    address2,
    landmark,
    city: city?.name ?? cityText,
    provinceCode,
    zip: zipText === '' ? null : zipText,
    location,
  };
}

/**
 * The address's pin (ADR-259): its latitude and longitude both, or neither; in Pakistan, and
 * within reach of its city where the city is one Hatti knows, since a pin added anywhere else
 * would send the rider astray. Null for none, or after adding errors.
 */
function checkLocation(
  check: InputChecker,
  field: string[],
  input: AddressInput,
  city: PkCity | null,
): MapPoint | null {
  const given = (value: number | string | null | undefined): value is number | string =>
    value !== null && value !== undefined && String(value).trim() !== '';
  const hasLatitude = given(input.latitude);
  const hasLongitude = given(input.longitude);
  if (!hasLatitude && !hasLongitude) return null;
  if (!hasLatitude || !hasLongitude) {
    const missing = hasLatitude ? 'longitude' : 'latitude';
    check.add(
      [...field, missing],
      'BLANK',
      `must be given with the ${hasLatitude ? 'latitude' : 'longitude'}`,
    );
    return null;
  }
  const latitude = parseDegrees(input.latitude!);
  const longitude = parseDegrees(input.longitude!);
  if (latitude === null || longitude === null) {
    check.add(
      [...field, latitude === null ? 'latitude' : 'longitude'],
      'INVALID',
      'must be a number of degrees, like 24.8607',
    );
    return null;
  }
  const point = { latitude, longitude };
  if (!inPakistan(point)) {
    check.addMessage([...field, 'latitude'], 'INVALID', 'The pin is not in Pakistan');
    return null;
  }
  const away = city ? distanceKm(point, city.centre) : 0;
  if (away > CITY_REACH_KM) {
    check.addMessage(
      [...field, 'latitude'],
      'INVALID',
      `The pin is ${Math.round(away)} km from ${city!.name}: it was not added at the address`,
    );
    return null;
  }
  return point;
}
