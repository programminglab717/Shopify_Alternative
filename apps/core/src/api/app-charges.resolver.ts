import { Inject } from '@nestjs/common';
import {
  CurrentTenant,
  InputChecker,
  Money,
  MoneyInput,
  RequireRecentAuthentication,
  UserError,
  deniedToRole,
  fail,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { AppChargeService, type AppChargeRecord } from '@hatti/apps/public';
import { BillingService } from '@hatti/billing/public';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { ADMIN_ORIGIN } from './constants.js';

export enum AppPurchaseStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  PAID = 'PAID',
  DECLINED = 'DECLINED',
}

registerEnumType(AppPurchaseStatus, {
  name: 'AppPurchaseStatus',
  valuesMap: {
    PENDING: { description: 'Waiting for the owner to answer.' },
    ACCEPTED: { description: 'Approved: its invoice waits to be paid.' },
    PAID: { description: 'Paid: the app gives what it charged for.' },
    DECLINED: { description: 'Declined by the owner.' },
  },
});

@ObjectType({
  description:
    "An installed app's one-time charge of the shop, in rupees (DEV-05, ADR-854), as Shopify's " +
    "AppPurchaseOneTime: approved by its owner, then paid as an invoice of Hatti's.",
})
export class AppPurchaseOneTime {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'What the app charges for.' })
  name!: string;

  @Field(() => Money)
  price!: Money;

  @Field(() => AppPurchaseStatus)
  status!: AppPurchaseStatus;

  @Field({ description: 'A charge on a development store: paid once approved, no money moving.' })
  test!: boolean;

  @Field()
  appName!: string;

  @Field({ description: 'Where the owner goes back to the app once they answered.' })
  returnUrl!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType()
export class AppPurchaseOneTimeCreatePayload {
  @Field(() => AppPurchaseOneTime, { nullable: true })
  appPurchaseOneTime!: AppPurchaseOneTime | null;

  @Field(() => String, {
    nullable: true,
    description: "Where to send the shop's owner to approve it, in the admin.",
  })
  confirmationUrl!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class AppPurchaseOneTimeAnswerPayload {
  @Field(() => AppPurchaseOneTime, { nullable: true })
  appPurchaseOneTime!: AppPurchaseOneTime | null;

  @Field(() => ID, {
    nullable: true,
    description: 'The invoice to pay with billingInvoicePay; null for a test or a refusal.',
  })
  invoiceId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toPurchase = (record: AppChargeRecord) =>
  Object.assign(new AppPurchaseOneTime(), {
    id: toPublicId('appCharge', record.id),
    name: record.name,
    price: Money.from(money(record.price, 'PKR')),
    status: record.status.toUpperCase() as AppPurchaseStatus,
    test: record.test,
    appName: record.appName,
    returnUrl: record.returnUrl,
    createdAt: record.createdAt,
  });

/** The owner alone answers what an app charges: never other staff, nor apps. */
function owner(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff' || tenant.actor.role !== 'owner') {
    throw deniedToRole("Access denied. Only the shop's owner answers what apps charge.");
  }
}

/**
 * Apps' one-time charges (ADR-854): the apps module keeps them, billing invoices what the owner
 * approves, and the core puts the two together, with the admin's page to approve them on.
 */
@Resolver(() => AppPurchaseOneTime)
export class AppChargeResolver {
  constructor(
    private readonly charges: AppChargeService,
    private readonly billing: BillingService,
    @Inject(ADMIN_ORIGIN) private readonly admin: string,
  ) {}

  @Query(() => [AppPurchaseOneTime], {
    description: "The calling app's one-time charges, the latest first; for staff, every app's.",
  })
  async appPurchasesOneTime(@CurrentTenant() tenant: TenantContext): Promise<AppPurchaseOneTime[]> {
    return (await this.charges.list(tenant)).map(toPurchase);
  }

  @Query(() => AppPurchaseOneTime, { nullable: true })
  async appPurchaseOneTime(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AppPurchaseOneTime | null> {
    const uuid = tryFromPublicId(id, 'appCharge');
    const charge = uuid ? await this.charges.get(tenant, uuid) : null;
    return charge && toPurchase(charge);
  }

  @Mutation(() => AppPurchaseOneTimeCreatePayload, {
    description:
      'Asks the shop to pay the calling public app once, in rupees: its owner approves it at ' +
      '`confirmationUrl`. On a development store, a test.',
  })
  async appPurchaseOneTimeCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('name') name: string,
    @Args('price', { type: () => MoneyInput }) price: MoneyInput,
    @Args('returnUrl') returnUrl: string,
  ): Promise<AppPurchaseOneTimeCreatePayload> {
    const check = new InputChecker();
    if (price.currencyCode !== 'PKR')
      check.addMessage(['price', 'currencyCode'], 'INVALID', 'Charge in PKR');
    const paisa = check.price(['price', 'amount'], price.amount, 'PKR', { required: true });
    const result: MutationResult<AppChargeRecord> =
      !check.ok || paisa === null
        ? fail(check.errors)
        : await this.charges.create(tenant, { name, price: paisa, returnUrl });
    return Object.assign(new AppPurchaseOneTimeCreatePayload(), {
      appPurchaseOneTime: result.ok ? toPurchase(result.value) : null,
      confirmationUrl: result.ok
        ? `${this.admin}/${toPublicId('shop', tenant.shopId)}/settings/apps/charges/` +
          toPublicId('appCharge', result.value.id)
        : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AppPurchaseOneTimeAnswerPayload, {
    description:
      "Approves an app's charge: an invoice, paid with billingInvoicePay; a test is paid at " +
      'once. The owner alone, having signed in lately.',
  })
  @RequireRecentAuthentication()
  async appPurchaseOneTimeApprove(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AppPurchaseOneTimeAnswerPayload> {
    owner(tenant);
    const uuid = tryFromPublicId(id, 'appCharge');
    const charge = uuid ? await this.charges.get(tenant, uuid) : null;
    let result: MutationResult<AppChargeRecord>;
    if (!charge) result = failOne(['id'], 'NOT_FOUND', 'No app asked this charge');
    else if (charge.status === 'paid' || charge.status === 'declined') {
      result = failOne(['id'], 'INVALID', 'The charge was answered already');
    } else if (charge.test) {
      result = await this.charges.answer(tenant, charge.id, { invoiceId: null });
    } else {
      const invoice = await this.billing.invoiceAppCharge(tenant, {
        id: charge.id,
        publicAppId: charge.publicAppId,
        name: charge.name,
        price: charge.price,
      });
      result = await this.charges.answer(tenant, charge.id, { invoiceId: invoice.id });
    }
    return Object.assign(new AppPurchaseOneTimeAnswerPayload(), {
      appPurchaseOneTime: result.ok ? toPurchase(result.value) : null,
      invoiceId:
        result.ok && result.value.invoiceId
          ? toPublicId('billingInvoice', result.value.invoiceId)
          : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AppPurchaseOneTimeAnswerPayload, {
    description: "Declines an app's charge. The owner alone.",
  })
  async appPurchaseOneTimeDecline(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AppPurchaseOneTimeAnswerPayload> {
    owner(tenant);
    const uuid = tryFromPublicId(id, 'appCharge');
    const result = uuid
      ? await this.charges.answer(tenant, uuid, { declined: true })
      : failOne<AppChargeRecord>(['id'], 'NOT_FOUND', 'No app asked this charge');
    return Object.assign(new AppPurchaseOneTimeAnswerPayload(), {
      appPurchaseOneTime: result.ok ? toPurchase(result.value) : null,
      invoiceId: null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
