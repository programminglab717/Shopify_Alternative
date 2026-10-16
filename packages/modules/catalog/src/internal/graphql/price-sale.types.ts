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
import { Product } from './product.types.js';

export enum PriceSaleStatus {
  SCHEDULED = 'SCHEDULED',
  RUNNING = 'RUNNING',
  ENDED = 'ENDED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(PriceSaleStatus, {
  name: 'PriceSaleStatus',
  description:
    'Set ahead, running with its prices cut, ended with them put back, or cancelled before it ' +
    'started.',
});

@ObjectType({
  description:
    "A percentage off the shop's chosen products from a time to a time (CAT-17, ADR-443): when " +
    "it starts, each variant's price is cut to a whole unit and its old price shown as the " +
    'compare-at price; when it ends, both come back, unless the price was changed by hand ' +
    'meanwhile.',
})
export class PriceSale {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The shop\'s own name for it: "Eid sale".' })
  name!: string;

  @Field(() => Int, { description: '1 to 90.' })
  percentOff!: number;

  @Field(() => GraphQLISODateTime)
  startsAt!: Date;

  @Field(() => GraphQLISODateTime)
  endsAt!: Date;

  @Field(() => PriceSaleStatus)
  status!: PriceSaleStatus;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it ended: at its time, or cancelled while it ran.',
  })
  endedAt!: Date | null;

  @Field(() => Int, { description: 'How many of its products are still kept.' })
  productsCount!: number;

  /** Its products' IDs, for the `products` field. */
  productIds!: string[];

  /** Its products, by title; resolved on its own. */
  products?: Product[];

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@InputType()
export class PriceSaleCreateInput {
  @Field({ description: '1 to 100 characters.' })
  name!: string;

  @Field(() => Int, { description: '1 to 90.' })
  percentOff!: number;

  @Field(() => GraphQLISODateTime, {
    description: 'From now to a year ahead; now, or a minute from now at most, starts it at once.',
  })
  startsAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'After it starts, 90 days at most.' })
  endsAt!: Date;

  @Field(() => [ID], {
    description: "1 to 250 of the shop's products, none in another sale for any of these days.",
  })
  productIds!: string[];
}

@ObjectType()
export class PriceSalePayload {
  @Field(() => PriceSale, { nullable: true })
  priceSale!: PriceSale | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
