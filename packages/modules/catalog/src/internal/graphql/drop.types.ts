import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { DROP_LIMITS } from '../drops.js';

export enum DropStatus {
  SCHEDULED = 'SCHEDULED',
  LIVE = 'LIVE',
  ENDED = 'ENDED',
}

registerEnumType(DropStatus, {
  name: 'DropStatus',
  description: 'Whether a drop is still to start, on now, or over.',
});

@ObjectType({ description: 'A product of a drop.' })
export class DropProduct {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ description: "Its status now: a draft goes on sale at the drop's start." })
  status!: string;
}

@ObjectType({
  description:
    'Products put on sale together at a time, until an end (INV-09, OS-17, ADR-820): until it ' +
    'starts they sell to no one, and its drafts go on sale at its start; while it is live each ' +
    'customer, by their number, buys so many units of each at most.',
})
export class Drop {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => GraphQLISODateTime)
  startsAt!: Date;

  @Field(() => GraphQLISODateTime)
  endsAt!: Date;

  @Field(() => DropStatus)
  status!: DropStatus;

  @Field(() => Int, {
    nullable: true,
    description: 'Units of each product a customer may buy while it is live; null for no limit.',
  })
  perCustomerLimit!: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Shoppers its waiting room lets in a minute; null for none (ADR-822).',
  })
  admitPerMinute!: number | null;

  @Field(() => [DropProduct], { description: 'By title.' })
  products!: DropProduct[];

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class DropInput {
  @Field({ description: `1 to ${DROP_LIMITS.name} characters.` })
  name!: string;

  @Field(() => GraphQLISODateTime, {
    description: 'A minute to a year ahead; a drop that has started keeps its start.',
  })
  startsAt!: Date;

  @Field(() => GraphQLISODateTime, {
    description: `After startsAt, ${DROP_LIMITS.days} days later at most.`,
  })
  endsAt!: Date;

  @Field(() => [ID], {
    description:
      `1 to ${DROP_LIMITS.products} products, none a gift card, none in another drop that has ` +
      'not ended.',
  })
  productIds!: string[];

  @Field(() => Int, {
    nullable: true,
    description:
      `Units of each product a customer may buy while it is live, ${DROP_LIMITS.perCustomer.min} ` +
      `to ${DROP_LIMITS.perCustomer.max}; none for no limit.`,
  })
  perCustomerLimit?: number | null;

  @Field(() => Int, {
    nullable: true,
    description:
      `Shoppers its waiting room lets in a minute, ${DROP_LIMITS.admitPerMinute.min} to ` +
      `${DROP_LIMITS.admitPerMinute.max.toLocaleString('en')}; none for no waiting room.`,
  })
  admitPerMinute?: number | null;
}

@ObjectType()
export class DropPayload {
  @Field(() => Drop, { nullable: true })
  drop!: Drop | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DropDeletePayload {
  @Field(() => ID, { nullable: true, description: 'Null where there was nothing to delete.' })
  deletedId!: string | null;
}
