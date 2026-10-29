// The fields of the starter's address form, as the Storefront API's MailingAddressInput names
// them (ADR-946), and Pakistan's provinces for its list. The API takes a province's name or code.

export const ADDRESS_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'address1',
  'address2',
  'landmark',
  'city',
  'province',
  'zip',
] as const;

export type AddressField = (typeof ADDRESS_FIELDS)[number];

export const PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Islamabad Capital Territory',
  'Gilgit-Baltistan',
  'Azad Kashmir',
] as const;
