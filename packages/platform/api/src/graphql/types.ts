import { CURRENCIES, formatMoney, toMajorString, type Money as MoneyValue } from '@hatti/money';
import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

/** GraphQL enum of supported currencies, named after ISO 4217 codes. */
export const CurrencyCode = Object.fromEntries(
  Object.keys(CURRENCIES).map((code) => [code, code]),
) as { [K in keyof typeof CURRENCIES]: K };

registerEnumType(CurrencyCode, {
  name: 'CurrencyCode',
  description: 'ISO 4217 currency code.',
});

@ObjectType({ description: 'An amount of money in a currency.' })
export class Money {
  @Field({ description: 'Decimal amount in major units, e.g. "12500.00".' })
  amount!: string;

  @Field(() => CurrencyCode)
  currencyCode!: keyof typeof CURRENCIES;

  @Field({ description: 'Display form with South Asian digit grouping, e.g. "Rs 12,500".' })
  formatted!: string;

  static from(value: MoneyValue): Money {
    return Object.assign(new Money(), {
      amount: toMajorString(value),
      currencyCode: value.currency,
      formatted: formatMoney(value),
    });
  }
}

@ObjectType({ description: 'Pagination state of a connection.' })
export class PageInfo {
  @Field()
  hasNextPage!: boolean;

  @Field(() => String, { nullable: true })
  endCursor!: string | null;
}

@ObjectType({ description: 'A problem with the input of a mutation, for showing to the user.' })
export class UserError {
  @Field(() => [String], {
    nullable: true,
    description: 'Path to the input field at fault, e.g. ["input", "title"].',
  })
  field!: string[] | null;

  @Field()
  message!: string;

  @Field({ description: 'Stable machine-readable code, e.g. BLANK, TAKEN, INVALID, NOT_FOUND.' })
  code!: string;

  static of(field: string[] | null, code: string, message: string): UserError {
    return Object.assign(new UserError(), { field, code, message });
  }
}
