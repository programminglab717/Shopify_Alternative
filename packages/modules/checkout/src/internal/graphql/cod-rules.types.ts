import { Money, UserError } from '@hatti/api';
import {
  Field,
  Float,
  GraphQLISODateTime,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum CashOnDeliveryAdvanceKind {
  FIXED_AMOUNT = 'FIXED_AMOUNT',
  PERCENTAGE = 'PERCENTAGE',
  DELIVERY_CHARGE = 'DELIVERY_CHARGE',
}

registerEnumType(CashOnDeliveryAdvanceKind, {
  name: 'CashOnDeliveryAdvanceKind',
  description: 'What cash on delivery asks for in advance.',
  valuesMap: {
    FIXED_AMOUNT: { description: "An amount, never more than the order's items." },
    PERCENTAGE: {
      description: "A percentage of the order's items after any discount code, to the rupee.",
    },
    DELIVERY_CHARGE: {
      description: "The order's delivery charge: nothing where delivery is free.",
    },
  },
});

@ObjectType({
  description:
    'What checkout asks for in advance on orders paid on delivery (CHK-10), saying it beside ' +
    "the option: the customer pays it by bank transfer into the shop's account, the order " +
    'waits for it as an order paid by transfer waits for its money, and the courier collects ' +
    'the rest. On every order, or only on those that meet each of its conditions: above a ' +
    'total, to one of its cities, by a customer who refused parcels before or is new to the ' +
    'shop, scored at a risk or higher. Checkout asks for none while the shop gives no account.',
})
export class CashOnDeliveryAdvance {
  @Field(() => CashOnDeliveryAdvanceKind)
  kind!: CashOnDeliveryAdvanceKind;

  @Field(() => Money, { nullable: true, description: 'What a FIXED_AMOUNT asks for.' })
  amount!: Money | null;

  @Field(() => Float, {
    nullable: true,
    description: "Percent of the order's items, for PERCENTAGE: 20 is 20%.",
  })
  percentage!: number | null;

  @Field(() => Money, {
    nullable: true,
    description:
      'Only on orders whose items, after any discount code, come to more; null for every order.',
  })
  above!: Money | null;

  @Field(() => [String], {
    description:
      'Only on orders to these cities, as addresses spell them: "Quetta". Empty for every city. ' +
      'Checkout names them all beside the option.',
  })
  cities!: string[];

  @Field(() => Int, {
    nullable: true,
    description:
      'Only of customers who refused this many parcels before, or more, as their delivery ' +
      'history counts them; null for every customer. Checkout says so, without looking anyone ' +
      'up, and placing the order counts the refusals of the number typed.',
  })
  refusedDeliveries!: number | null;

  @Field({
    description:
      'Only of customers new to the shop: none of their orders delivered before, by any of ' +
      'their numbers. Checkout says so, and placing the order counts the deliveries of the ' +
      'number typed.',
  })
  newCustomers!: boolean;

  @Field(() => Float, {
    nullable: true,
    description:
      "Only of orders the shop's risk rules score this or more, 0.01 to 1, as they are placed: " +
      'such an order is asked the advance instead of waiting for review, and keeps its score. ' +
      'Null for every order.',
  })
  riskScore!: number | null;
}

@ObjectType({
  description:
    "The shop's rules for cash on delivery at checkout (CHK-07): where they keep it from an " +
    "order, checkout offers bank transfer instead, or says why it can't take the order. Orders " +
    "staff and apps place are the shop's own call, and keep to the law's cap alone.",
})
export class CashOnDeliverySettings {
  @Field(() => Money, {
    nullable: true,
    description:
      "No cash on delivery for orders above it; null for no limit but the law's, Rs 200,000.",
  })
  maxOrderTotal!: Money | null;

  @Field(() => [String], {
    description: 'Cities where checkout doesn\'t offer it, as addresses spell them: "Gilgit".',
  })
  unavailableCities!: string[];

  @Field(() => [String], {
    description:
      'Products tagged with any of these, in any letter case, are paid another way, such as ' +
      'pre-orders and custom stitching: "pre-order". A cart holding one is offered bank ' +
      'transfer alone.',
  })
  unavailableProductTags!: string[];

  @Field(() => Int, {
    nullable: true,
    description:
      'Customers who refused this many parcels before, or more, pay another way; null for no ' +
      'limit. Their delivery history counts them: refused or undeliverable, coming back or back.',
  })
  refusedDeliveriesLimit!: number | null;

  @Field(() => Money, {
    description:
      'What an order paid on delivery is charged for it (CHK-08): checkout adds it, and the ' +
      'order keeps it apart from delivery. Nothing unless set.',
  })
  fee!: Money;

  @Field(() => CashOnDeliveryAdvance, {
    nullable: true,
    description: 'What it asks for in advance (CHK-10); null for nothing.',
  })
  advance!: CashOnDeliveryAdvance | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'null while the shop has set none.',
  })
  updatedAt!: Date | null;
}

@InputType({
  description:
    'An amount, a percentage or the delivery charge: one of the three; on every order, or only ' +
    'on those that meet each condition given.',
})
export class CashOnDeliveryAdvanceInput {
  @Field(() => String, { nullable: true, description: 'An amount, in the shop currency: "500".' })
  amount?: string | null;

  @Field(() => Float, {
    nullable: true,
    description:
      "Percent of the order's items after any discount code, 0.01 to 100, with two decimals " +
      'at most.',
  })
  percentage?: number | null;

  @Field(() => Boolean, { nullable: true, description: "True for the order's delivery charge." })
  deliveryCharge?: boolean | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Only on orders whose items come to more, in the shop currency: "10,000". Blank or null ' +
      'for every order.',
  })
  above?: string | null;

  @Field(() => [String], {
    nullable: true,
    description:
      'Only on orders to these cities, by name, alias or code, as addresses have them: ' +
      '"Quetta", "khi". Empty or null for every city. Up to 50.',
  })
  cities?: string[] | null;

  @Field(() => Int, {
    nullable: true,
    description:
      'Only of customers who refused this many parcels before, or more: 1 to 100; null for ' +
      'every customer.',
  })
  refusedDeliveries?: number | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'True for customers new to the shop alone: none of their orders delivered.',
  })
  newCustomers?: boolean | null;

  @Field(() => Float, {
    nullable: true,
    description:
      'Only of orders the risk rules score this or more: 0.01 to 1, in hundredths; null for ' +
      'every order.',
  })
  riskScore?: number | null;
}

@InputType({ description: 'Those not given stay as they are.' })
export class CashOnDeliverySettingsInput {
  @Field(() => String, {
    nullable: true,
    description: 'Decimal, e.g. "25,000"; null or blank for no limit but the law\'s.',
  })
  maxOrderTotal?: string | null;

  @Field(() => [String], {
    nullable: true,
    description:
      'Replaces them all; an empty list for none. Cities by name, alias or code, as addresses ' +
      'have them: "Gilgit", "isb". Up to 200.',
  })
  unavailableCities?: string[] | null;

  @Field(() => [String], {
    nullable: true,
    description:
      'Replaces them all; an empty list for none. Tags as the shop writes them on its ' +
      'products, each once in any letter case. Up to 50.',
  })
  unavailableProductTags?: string[] | null;

  @Field(() => Int, { nullable: true, description: '1 to 100; null for no limit.' })
  refusedDeliveriesLimit?: number | null;

  @Field(() => String, { nullable: true, description: 'Decimal, e.g. "100"; null for nothing.' })
  fee?: string | null;

  @Field(() => CashOnDeliveryAdvanceInput, {
    nullable: true,
    description:
      "Replaces what it asks for in advance, which needs the shop's bank account. null takes it " +
      'away; orders placed before keep theirs.',
  })
  advance?: CashOnDeliveryAdvanceInput | null;
}

@ObjectType()
export class CashOnDeliverySettingsUpdatePayload {
  @Field(() => CashOnDeliverySettings, { nullable: true })
  cashOnDeliverySettings!: CashOnDeliverySettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
