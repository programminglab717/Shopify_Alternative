import { Money, UserError } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import { Field, Float, GraphQLISODateTime, InputType, ObjectType } from '@nestjs/graphql';
import { SALES_TAX } from '../tax.js';

@ObjectType({
  description:
    "A rate of the shop's own for some products (ADR-097): those whose variants' taxCode is its " +
    "code, in any letter case. Every other variant the shop taxes is at the shop's rate.",
})
export class TaxCategory {
  @Field({ description: 'As variants name it, Shopify\'s tax code: "REDUCED".' })
  code!: string;

  @Field({ description: 'What the shop calls it, such as "Reduced rate".' })
  name!: string;

  @Field(() => Float, { description: 'Percent: 10 is 10%.' })
  rate!: number;
}

@ObjectType({
  description:
    'The sales tax the shop charges (TAX-01): a rate included in the prices of what it sells, as ' +
    "Pakistan's consumer laws ask prices to be shown, and in its delivery charges if it says " +
    'so. Orders keep the tax in them as they were placed, for receipts and invoices.',
})
export class TaxSettings {
  @Field(() => Float, {
    nullable: true,
    description: 'Percent included in its prices: 18 is 18%. Null: it charges none.',
  })
  rate!: number | null;

  @Field({
    description:
      'Whether its delivery charges, and its fee for paying on delivery, include it too, as ' +
      "Shopify's taxShipping.",
  })
  taxDelivery!: boolean;

  @Field(() => [TaxCategory], {
    description:
      "Rates of its own for some products, in the shop's order; they apply while the shop " +
      'charges tax at all.',
  })
  categories!: TaxCategory[];

  @Field(() => String, {
    nullable: true,
    description:
      'The NTN FBR registered the shop under, which its invoices name: "1234567-8", or a sole ' +
      'trader\'s CNIC, "35202-1234567-1". Null for none.',
  })
  ntn!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Its sales tax registration number, 13 digits: its invoices name it and are sales tax ' +
      'invoices. Null for none.',
  })
  strn!: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'null while the shop has set none.',
  })
  updatedAt!: Date | null;
}

@InputType()
export class TaxCategoryInput {
  @Field({
    description:
      'Letters, digits, dots, dashes or underscores, up to 40: the tax code variants name, ' +
      'each once in any letter case.',
  })
  code!: string;

  @Field({ description: 'Up to 60 characters.' })
  name!: string;

  @Field(() => Float, { description: 'Percent, 10 for 10%: from 0.01 to 50, in hundredths.' })
  rate!: number;
}

@InputType({ description: 'Those not given stay as they are.' })
export class TaxSettingsUpdateInput {
  @Field(() => Float, {
    nullable: true,
    description: 'Percent, 18 for 18%: from 0.01 to 50, in hundredths. null charges none.',
  })
  rate?: number | null;

  @Field(() => Boolean, { nullable: true })
  taxDelivery?: boolean | null;

  @Field(() => [TaxCategoryInput], {
    nullable: true,
    description: 'Replaces every category; an empty list for none. Up to 20.',
  })
  categories?: TaxCategoryInput[] | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Seven digits and a check digit, or a CNIC, dashes and spaces as typed; null or blank for ' +
      'none.',
  })
  ntn?: string | null;

  @Field(() => String, {
    nullable: true,
    description: '13 digits, dashes and spaces as typed; null or blank for none.',
  })
  strn?: string | null;
}

@ObjectType()
export class TaxSettingsUpdatePayload {
  @Field(() => TaxSettings, { nullable: true })
  taxSettings!: TaxSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "A tax included in a price, as Shopify's TaxLine: what of an order's line, or of the order, " +
    'was sales tax, at what rate.',
})
export class TaxLine {
  @Field({ description: '"Sales tax".' })
  title!: string;

  @Field(() => Float, { description: 'As a fraction: 0.18 for 18%.' })
  rate!: number;

  @Field(() => Float, { description: 'As a percentage: 18 for 18%.' })
  ratePercentage!: number;

  @Field(() => Money, { description: 'What it came to, included in the price.' })
  price!: Money;
}

/** A tax line of `amount`, minor units of `currency`, at `rate` hundredths of a percent. */
export function toTaxLine(rate: number, amount: bigint, currency: CurrencyCode): TaxLine {
  return Object.assign(new TaxLine(), {
    title: SALES_TAX.en,
    rate: rate / 10_000,
    ratePercentage: rate / 100,
    price: Money.from(money(amount, currency)),
  });
}
