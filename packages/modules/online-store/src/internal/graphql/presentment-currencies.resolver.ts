import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { formatRate } from '@hatti/money';
import {
  Args,
  Field,
  GraphQLISODateTime,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import {
  PresentmentCurrencyService,
  type CurrencyRateRecord,
  type PresentmentCurrencyRecord,
} from '../presentment-currencies.js';

@ObjectType({
  description:
    'A currency the shop shows its prices in besides rupees (OS-21, ADR-865), for shoppers abroad: ' +
    'at a rate it fixes, or the day’s. Checkout charges rupees.',
})
export class PresentmentCurrency {
  @Field({ description: 'AED, SAR, GBP, USD, CAD or EUR.' })
  currencyCode!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Rupees for one unit, as the shop fixes it: "76.4521". Null to follow the day’s.',
  })
  fixedRate!: string | null;

  @Field({ description: 'exact, to the cent; whole, to a whole unit; or ninety_nine, up to .99.' })
  rounding!: string;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({
  description: "A currency's rate on the day, from the open currency feed Hatti reads.",
})
export class CurrencyRate {
  @Field()
  currencyCode!: string;

  @Field({ description: 'Rupees for one unit: "76.4521".' })
  rate!: string;

  @Field({ description: "The feed's day, YYYY-MM-DD." })
  rateDate!: string;
}

@InputType()
export class PresentmentCurrencyInput {
  @Field()
  currencyCode!: string;

  @Field(() => String, { nullable: true, description: 'Blank or null to follow the day’s rate.' })
  fixedRate?: string | null;

  @Field(() => String, { nullable: true, defaultValue: 'exact' })
  rounding?: string | null;
}

@ObjectType()
export class PresentmentCurrenciesSetPayload {
  @Field(() => [PresentmentCurrency], { nullable: true })
  presentmentCurrencies!: PresentmentCurrency[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toCurrency = (record: PresentmentCurrencyRecord) =>
  Object.assign(new PresentmentCurrency(), {
    currencyCode: record.currency,
    fixedRate: record.fixedRate === null ? null : formatRate(record.fixedRate),
    rounding: record.rounding,
    updatedAt: record.updatedAt,
  });

const toRate = (record: CurrencyRateRecord) =>
  Object.assign(new CurrencyRate(), {
    currencyCode: record.currency,
    rate: formatRate(record.rate),
    rateDate: record.rateDate,
  });

/** The currencies the shop shows its prices in (ADR-865), kept by those who change settings. */
@Resolver(() => PresentmentCurrency)
export class PresentmentCurrencyResolver {
  constructor(private readonly currencies: PresentmentCurrencyService) {}

  @Query(() => [PresentmentCurrency], {
    description:
      "The currencies the shop shows its prices in besides rupees, in its picker's order.",
  })
  @RequireScopes('read_settings')
  async presentmentCurrencies(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<PresentmentCurrency[]> {
    return (await this.currencies.list(tenant)).map(toCurrency);
  }

  @Query(() => [CurrencyRate], {
    description:
      "The day's rates, rupees for one unit, that currencies without a fixed rate follow.",
  })
  @RequireScopes('read_settings')
  async currencyRates(@CurrentTenant() tenant: TenantContext): Promise<CurrencyRate[]> {
    return (await this.currencies.rates(tenant)).map(toRate);
  }

  @Mutation(() => PresentmentCurrenciesSetPayload, {
    description:
      'Sets the currencies the shop shows its prices in, in its picker’s order, replacing those ' +
      'it had; none to show rupees alone.',
  })
  @RequireScopes('write_settings')
  async presentmentCurrenciesSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('input', { type: () => [PresentmentCurrencyInput] }) input: PresentmentCurrencyInput[],
  ): Promise<PresentmentCurrenciesSetPayload> {
    const result = await this.currencies.set(
      tenant,
      input.map((each) => ({
        currency: each.currencyCode,
        fixedRate: each.fixedRate ?? null,
        rounding: each.rounding ?? null,
      })),
    );
    return Object.assign(new PresentmentCurrenciesSetPayload(), {
      presentmentCurrencies: result.ok ? result.value.map(toCurrency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
