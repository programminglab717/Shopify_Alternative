import { CurrentTenant, RequireScopes, type TenantContext } from '@hatti/api';
import { Field, Int, ObjectType, Query, Resolver, registerEnumType } from '@nestjs/graphql';
import { SetupChecklistService } from './setup-checklist.js';

export enum SetupStepKey {
  PRODUCTS = 'PRODUCTS',
  DELIVERY = 'DELIVERY',
  COURIERS = 'COURIERS',
  PAYMENTS = 'PAYMENTS',
  POLICIES = 'POLICIES',
  BRAND = 'BRAND',
  WHATSAPP = 'WHATSAPP',
  OPEN = 'OPEN',
}

registerEnumType(SetupStepKey, {
  name: 'SetupStepKey',
  description: 'A step of setting up a shop, as the setup checklist asks for it.',
  valuesMap: {
    PRODUCTS: { description: 'Products on sale (ACTIVE): done with one; its count says how many.' },
    DELIVERY: { description: 'Delivery charges set: done once deliverySettingsUpdate saved them.' },
    COURIERS: {
      description:
        "A courier account connected, which books the shop's parcels and follows them; the test " +
        "courier's doesn't count.",
    },
    PAYMENTS: {
      description:
        "A way to be paid ahead of delivery: a payment gateway's account in its production, " +
        'which takes real money, or the bank account transfers, Raast and advances go to. Cash ' +
        'on delivery needs nothing.',
    },
    POLICIES: {
      description:
        'The refund, privacy, shipping policies and terms of service written; its count says ' +
        'how many of the four.',
    },
    BRAND: { description: "The shop's logo, which its checkout and customers' pages show." },
    WHATSAPP: { description: 'The WhatsApp number its storefront\'s "Order on WhatsApp" goes to.' },
    OPEN: { description: 'The storefront open to shoppers, not closed behind its password.' },
  },
});

@ObjectType({ description: 'A step of the setup checklist, and whether the shop has done it.' })
export class SetupStep {
  @Field(() => SetupStepKey)
  key!: SetupStepKey;

  @Field()
  done!: boolean;

  @Field(() => Int, {
    nullable: true,
    description: 'How far along a step of many things is: products on sale, policies written.',
  })
  count!: number | null;
}

@ObjectType({
  description:
    'What a new shop sets up before it sells (ONB-02), in the order it is asked to, worked out ' +
    'from the shop as it is: a step is done as soon as what it asks for is, and undone when it ' +
    'no longer is. The admin app words each step in English and Urdu.',
})
export class SetupChecklist {
  @Field(() => [SetupStep])
  steps!: SetupStep[];

  @Field(() => Int, { description: 'Steps done.' })
  done!: number;

  @Field(() => Int, { description: 'Steps in all.' })
  total!: number;
}

/** The setup checklist (ONB-02, ADR-095), from each module's state. */
@Resolver()
export class SetupResolver {
  constructor(private readonly checklist: SetupChecklistService) {}

  @Query(() => SetupChecklist, {
    description: "What the shop has left to set up before it sells: the admin's setup checklist.",
  })
  @RequireScopes('read_settings')
  async setupChecklist(@CurrentTenant() tenant: TenantContext): Promise<SetupChecklist> {
    const steps = await this.checklist.get(tenant);
    return Object.assign(new SetupChecklist(), {
      steps: steps.map((step) =>
        Object.assign(new SetupStep(), {
          key: step.step.toUpperCase() as SetupStepKey,
          done: step.done,
          count: step.count,
        }),
      ),
      done: steps.filter((step) => step.done).length,
      total: steps.length,
    });
  }
}
