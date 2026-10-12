import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { TrackingInfo } from './order.types.js';

export enum DeliveryRescueAnswer {
  RETRY = 'RETRY',
  CALL = 'CALL',
}

registerEnumType(DeliveryRescueAnswer, {
  name: 'DeliveryRescueAnswer',
  description: 'What a customer answered when told their delivery failed (COD-08, ADR-388).',
  valuesMap: {
    RETRY: { description: 'To have it delivered again.' },
    CALL: { description: 'To be called before it is delivered again.' },
  },
});

@ObjectType({
  description:
    'A parcel on its way whose last step is a failed delivery (COD-08, ADR-388): one to rescue ' +
    'before its courier sends it back.',
})
export class DeliveryToRescue {
  @Field(() => ID, { description: "The parcel's (Fulfillment) ID." })
  id!: string;

  @Field(() => ID)
  orderId!: string;

  @Field({ description: 'Such as "#1001".' })
  orderName!: string;

  @Field(() => String, {
    nullable: true,
    description: "As the order's address has it; null once the customer's data is erased.",
  })
  customerName!: string | null;

  @Field(() => String, { nullable: true })
  city!: string | null;

  @Field(() => TrackingInfo)
  trackingInfo!: TrackingInfo;

  @Field(() => GraphQLISODateTime, { description: 'When the courier last tried.' })
  attemptedAt!: Date;

  @Field(() => String, {
    nullable: true,
    description: 'What the courier said of it: "Customer not available".',
  })
  reason!: string | null;

  @Field(() => Int, { description: 'How many times the courier has tried.' })
  attempts!: number;

  @Field(() => DeliveryRescueAnswer, {
    nullable: true,
    description: 'What the customer answered on WhatsApp since that last try; null while not.',
  })
  answer!: DeliveryRescueAnswer | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  answeredAt!: Date | null;
}

@ObjectType({ description: 'The parcels to rescue (COD-08, ADR-388).' })
export class DeliveriesToRescue {
  @Field(() => Int, { description: 'All of them, however many are listed.' })
  count!: number;

  @Field(() => [DeliveryToRescue], {
    description:
      'Those whose customers answered first, the latest answer first, for the shop to tell their ' +
      'couriers; then the latest tries.',
  })
  parcels!: DeliveryToRescue[];
}
