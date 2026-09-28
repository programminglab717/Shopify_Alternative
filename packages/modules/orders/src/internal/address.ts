import type { InputChecker } from '@hatti/api';
import { findCity, findProvince, normalizeDigits } from '@hatti/pk';
import { LIMITS } from './rules.js';
import type { AddressValue } from './schema.js';

export interface AddressInput {
  /** Who receives the parcel. */
  name: string;
  /** Mobile number, in any common format; couriers call it before delivering. */
  phone: string;
  address1: string;
  /** Often a landmark: "near Jamia Masjid". */
  address2?: string | null;
  /** Known cities are spelled the standard way: "khi" becomes "Karachi". */
  city: string;
  /** Code ("SD"), name ("Sindh") or alias ("KPK"). From the city when left out. */
  province?: string | null;
  /** Five-digit postcode. */
  zip?: string | null;
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

  if (check.errors.length > errorsBefore || !name || !phone || !address1 || !cityText) return null;
  return {
    name,
    phone,
    address1,
    address2,
    city: city?.name ?? cityText,
    provinceCode,
    zip: zipText === '' ? null : zipText,
  };
}
