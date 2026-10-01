import type { CurrencyCode } from '@hatti/money';
import { InputChecker, LIMITS } from './input-checker.js';

/** Fields a variant can be created or updated with. Amounts are decimal strings, e.g. "2,499.50". */
export interface VariantFieldsInput {
  /** One value per option, in option order, e.g. ["M", "Maroon"]. */
  optionValues?: string[] | null;
  price?: string | null;
  /** null clears it. */
  compareAtPrice?: string | null;
  sku?: string | null;
  barcode?: string | null;
  cost?: string | null;
  weightGrams?: number | null;
  /** Whether its price includes the shop's sales tax, as Shopify's "Charge tax"; null leaves it. */
  taxable?: boolean | null;
  /** Shopify's tax code, naming one of the shop's tax categories; null or blank clears it. */
  taxCode?: string | null;
}

/** Checked variant fields. `undefined` means "not given", so updates leave the field alone. */
export interface VariantFields {
  optionValues?: string[];
  price?: bigint;
  compareAtPrice?: bigint | null;
  sku?: string | null;
  barcode?: string | null;
  cost?: bigint | null;
  weightGrams?: number | null;
  taxable?: boolean;
  taxCode?: string | null;
}

export interface OptionInput {
  name: string;
  values: string[];
}

/** A product option as the checks see it: name and value names in order. */
export interface OptionShape {
  name: string;
  values: string[];
}

const MAX_WEIGHT_GRAMS = 1_000_000;

/** A tax code as the tax module's categories name them (ADR-097): "REDUCED". */
const TAX_CODE = /^[A-Za-z0-9._-]{1,40}$/;

export function checkVariantFields(
  check: InputChecker,
  field: string[],
  input: VariantFieldsInput,
  currency: CurrencyCode,
  options: { requirePrice: boolean },
): VariantFields {
  const at = (name: string) => [...field, name];
  const fields: VariantFields = {};
  if (input.optionValues !== undefined && input.optionValues !== null) {
    fields.optionValues = input.optionValues.map((value) => value.trim());
  }
  if (options.requirePrice || (input.price !== undefined && input.price !== null)) {
    fields.price = check.price(at('price'), input.price, currency, { required: true }) ?? 0n;
  } else if (input.price === null) {
    check.add(at('price'), 'BLANK', "can't be blank");
  }
  if (input.compareAtPrice !== undefined) {
    fields.compareAtPrice = check.price(at('compareAtPrice'), input.compareAtPrice, currency);
  }
  if (input.cost !== undefined) fields.cost = check.price(at('cost'), input.cost, currency);
  if (input.sku !== undefined) {
    fields.sku = check.text(at('sku'), input.sku, { max: LIMITS.shortText });
  }
  if (input.barcode !== undefined) {
    fields.barcode = check.text(at('barcode'), input.barcode, { max: LIMITS.shortText });
  }
  if (input.weightGrams !== undefined) {
    fields.weightGrams = check.integer(at('weightGrams'), input.weightGrams, {
      min: 0,
      max: MAX_WEIGHT_GRAMS,
    });
  }
  if (input.taxable !== undefined && input.taxable !== null) fields.taxable = input.taxable;
  if (input.taxCode !== undefined) {
    const code = input.taxCode?.trim() || null;
    if (code !== null && !TAX_CODE.test(code)) {
      check.addMessage(
        at('taxCode'),
        'INVALID',
        'Tax code must be 1 to 40 letters, digits, dots, dashes or underscores, like REDUCED',
      );
    }
    fields.taxCode = code;
  }
  return fields;
}

/** Checks new options: names and values present, not too long, and not repeated. */
export function checkOptionInputs(
  check: InputChecker,
  field: string[],
  inputs: readonly OptionInput[],
  existingNames: readonly string[] = [],
): OptionShape[] {
  if (existingNames.length + inputs.length > LIMITS.options) {
    check.add(field, 'TOO_MANY', `can have at most ${LIMITS.options} in all`);
  }
  const seen = new Set(existingNames.map((name) => name.toLowerCase()));
  return inputs.map((input, index) => {
    const at = [...field, String(index)];
    const name = check.text([...at, 'name'], input.name, {
      required: true,
      max: LIMITS.shortText,
    });
    if (name !== null) {
      if (seen.has(name.toLowerCase())) {
        check.addMessage(
          [...at, 'name'],
          'TAKEN',
          `The product already has an option named ${name}`,
        );
      }
      seen.add(name.toLowerCase());
    }
    return { name: name ?? '', values: checkValueNames(check, [...at, 'values'], input.values) };
  });
}

/** Checks option value names: present, not too long, not repeated, not too many. */
export function checkValueNames(
  check: InputChecker,
  field: string[],
  names: readonly string[],
  existing: readonly string[] = [],
  options: { required?: boolean } = { required: true },
): string[] {
  if (options.required && names.length === 0 && existing.length === 0) {
    check.add(field, 'BLANK', 'must include at least one value');
  }
  if (existing.length + names.length > LIMITS.optionValues) {
    check.add(field, 'TOO_MANY', `can have at most ${LIMITS.optionValues}`);
  }
  const seen = new Set(existing.map((name) => name.toLowerCase()));
  const values: string[] = [];
  names.forEach((raw, index) => {
    const name = check.text([...field, String(index)], raw, {
      required: true,
      max: LIMITS.shortText,
    });
    if (name === null) return;
    if (seen.has(name.toLowerCase())) {
      check.addMessage(
        [...field, String(index)],
        'TAKEN',
        `The option already has a value ${name}`,
      );
      return;
    }
    seen.add(name.toLowerCase());
    values.push(name);
  });
  return values;
}

/**
 * Matches a variant's option values to the product's options, ignoring case, and returns the
 * values as the options spell them, or null if they don't fit. With `allowNew`, a value the option
 * lacks is accepted as given (bulk create adds it to the option).
 */
export function resolveOptionValues(
  check: InputChecker,
  field: string[],
  given: readonly string[] | undefined,
  options: readonly OptionShape[],
  allowNew = false,
): string[] | null {
  const values = given ?? [];
  if (options.length === 0) {
    if (values.length > 0) {
      check.addMessage(field, 'INVALID', 'The product has no options; add options first');
      return null;
    }
    return [];
  }
  if (values.length !== options.length) {
    check.addMessage(
      field,
      'INVALID',
      `Give one value for each option (${options.map((option) => option.name).join(', ')})`,
    );
    return null;
  }
  const resolved: string[] = [];
  for (const [index, option] of options.entries()) {
    const value = values[index]!.trim();
    const known = option.values.find((name) => name.toLowerCase() === value.toLowerCase());
    if (known) {
      resolved.push(known);
    } else if (allowNew && value.length > 0 && value.length <= LIMITS.shortText) {
      resolved.push(value);
    } else {
      check.addMessage(
        [...field, String(index)],
        'INVALID',
        value.length === 0
          ? `${option.name} can't be blank`
          : `${option.name} has no value ${value}`,
      );
      return null;
    }
  }
  return resolved;
}

/** Every combination of the options' values, in order: S/Red, S/Blue, M/Red, … */
export function combinations(options: readonly OptionShape[]): string[][] {
  return options.reduce<string[][]>(
    (combos, option) => combos.flatMap((combo) => option.values.map((value) => [...combo, value])),
    [[]],
  );
}

/** A key for a combination that ignores case. */
export function comboKey(values: readonly string[]): string {
  return values.map((value) => value.toLowerCase()).join('\u0000');
}
