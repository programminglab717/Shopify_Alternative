import { Money, UserError } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
import {
  Field,
  Float,
  GraphQLISODateTime,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
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

export enum TaxProvince {
  PUNJAB = 'PUNJAB',
  SINDH = 'SINDH',
  KHYBER_PAKHTUNKHWA = 'KHYBER_PAKHTUNKHWA',
  BALOCHISTAN = 'BALOCHISTAN',
  ISLAMABAD = 'ISLAMABAD',
  GILGIT_BALTISTAN = 'GILGIT_BALTISTAN',
  AZAD_KASHMIR = 'AZAD_KASHMIR',
}

registerEnumType(TaxProvince, {
  name: 'TaxProvince',
  description: "Where the shop's business is registered (ONB-12, ADR-500).",
});

export enum FilerStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  UNKNOWN = 'UNKNOWN',
}

registerEnumType(FilerStatus, {
  name: 'FilerStatus',
  description:
    "Whether the shop is on FBR's Active Taxpayers List, as it says: ACTIVE, INACTIVE, or " +
    'UNKNOWN, taken as not on it.',
});

export enum TaxGuidanceCode {
  REGISTER_NTN = 'REGISTER_NTN',
  REGISTER_SALES_TAX = 'REGISTER_SALES_TAX',
  JOIN_ACTIVE_TAXPAYERS = 'JOIN_ACTIVE_TAXPAYERS',
  NAME_PROVINCE = 'NAME_PROVINCE',
  DIGITAL_INVOICING = 'DIGITAL_INVOICING',
  TIER1_RETURNS = 'TIER1_RETURNS',
}

registerEnumType(TaxGuidanceCode, {
  name: 'TaxGuidanceCode',
  description:
    'A step of registering with FBR as an online seller (ONB-12, ADR-500): an NTN; sales tax ' +
    "registration; the Active Taxpayers List; the business's province; FBR's digital invoicing, " +
    "for one registered for sales tax; and a Tier-1 retailer's monthly returns.",
});

export enum TaxGuidanceStatus {
  DONE = 'DONE',
  TO_DO = 'TO_DO',
  NOTE = 'NOTE',
}

registerEnumType(TaxGuidanceStatus, {
  name: 'TaxGuidanceStatus',
  description: 'DONE, TO_DO, or a NOTE for a shop like this one, with nothing to tick off.',
});

@ObjectType({ description: "A step of the shop's registration with FBR, as its profile says." })
export class TaxGuidanceStep {
  @Field(() => TaxGuidanceCode)
  code!: TaxGuidanceCode;

  @Field(() => TaxGuidanceStatus)
  status!: TaxGuidanceStatus;
}

@ObjectType({
  description:
    "Income tax couriers and payment gateways withhold from the shop's online sales (s.6A), as " +
    'percentages: double for a shop not on the Active Taxpayers List.',
})
export class TaxWithholding {
  @Field(() => Int, { description: 'From what customers pay online, by the gateway.' })
  digitalPercent!: number;

  @Field(() => Int, { description: 'From cash on delivery, by the courier.' })
  cashOnDeliveryPercent!: number;
}

export enum FilerCheckDue {
  NEVER = 'NEVER',
  NEW_LIST = 'NEW_LIST',
}

registerEnumType(FilerCheckDue, {
  name: 'FilerCheckDue',
  description:
    'Why the shop should check whether it is on the Active Taxpayers List: it has NEVER said, or FBR published a NEW_LIST since it last did.',
});

@ObjectType({
  description:
    "Helping the shop check whether it is on FBR's Active Taxpayers List (TAX-08, ADR-837), " +
    'which FBR answers by SMS and on its site alone.',
})
export class TaxFilerCheck {
  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last said whether it is on the list; null for never.',
  })
  checkedAt!: Date | null;

  @Field(() => FilerCheckDue, {
    nullable: true,
    description: 'Why it should check now; null while what it said holds.',
  })
  due!: FilerCheckDue | null;

  @Field(() => GraphQLISODateTime, {
    description: 'When FBR published the list in force: each 1 March, in Pakistan.',
  })
  listOf!: Date;

  @Field(() => String, {
    nullable: true,
    description:
      'What to text to 9966 for FBR to say whether the shop is on the list: "ATL" and its NTN\'s ' +
      "seven digits, or a sole trader's CNIC. Null while its NTN is unknown.",
  })
  smsBody!: string | null;
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

  @Field(() => TaxProvince, {
    nullable: true,
    description: 'Where its business is registered; null while it says none.',
  })
  province!: TaxProvince | null;

  @Field(() => FilerStatus)
  filerStatus!: FilerStatus;

  @Field({
    description:
      'Whether it is a Tier-1 retailer, for whom the sales tax gateways and couriers collect is ' +
      'an advance against its own.',
  })
  tier1!: boolean;

  @Field(() => TaxWithholding, { description: 'What its filer status means it is withheld.' })
  withholding!: TaxWithholding;

  @Field(() => [TaxGuidanceStep], {
    description: 'What it has done to register as an online seller must, and what is left.',
  })
  guidance!: TaxGuidanceStep[];

  @Field(() => TaxFilerCheck, {
    description: 'Checking whether it is on the Active Taxpayers List, and when to again.',
  })
  filerCheck!: TaxFilerCheck;

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

  @Field(() => TaxProvince, { nullable: true, description: 'null for none.' })
  province?: TaxProvince | null;

  @Field(() => FilerStatus, { nullable: true })
  filerStatus?: FilerStatus | null;

  @Field(() => Boolean, { nullable: true })
  tier1?: boolean | null;
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
