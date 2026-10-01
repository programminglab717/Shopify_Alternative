import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum CustomerCancellation {
  UNTIL_CONFIRMED = 'UNTIL_CONFIRMED',
  UNTIL_PACKED = 'UNTIL_PACKED',
}

registerEnumType(CustomerCancellation, {
  name: 'CustomerCancellation',
  description:
    'How long a cash-on-delivery customer may cancel their order through its link, while ' +
    'nothing has been paid or shipped.',
  valuesMap: {
    UNTIL_CONFIRMED: { description: 'While the order waits for them to confirm it.' },
    UNTIL_PACKED: {
      description:
        'Until the order is packed, though they confirmed it: then it costs the shop nothing, ' +
        'where a parcel refused at the door costs a return. The default.',
    },
  },
});

@ObjectType({ description: "The shop's policies for its orders, but for risk." })
export class OrderSettings {
  @Field(() => CustomerCancellation)
  customerCancellation!: CustomerCancellation;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last changed them; none while it has the defaults.',
  })
  updatedAt!: Date | null;
}

@InputType()
export class OrderSettingsInput {
  @Field(() => CustomerCancellation, { nullable: true })
  customerCancellation?: CustomerCancellation | null;
}

@ObjectType()
export class OrderSettingsUpdatePayload {
  @Field(() => OrderSettings, { nullable: true })
  orderSettings!: OrderSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
