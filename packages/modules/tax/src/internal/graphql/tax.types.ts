import { Money, UserError } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import { Field, Float, GraphQLISODateTime, InputType, ObjectType } from '@nestjs/graphql';
import { SALES_TAX } from '../tax.js';

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

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'null while the shop has set none.',
  })
  updatedAt!: Date | null;
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
