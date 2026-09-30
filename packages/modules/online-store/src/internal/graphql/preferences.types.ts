import { UserError } from '@hatti/api';
import { Field, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'What the shop sets for its storefront as a whole.' })
export class OnlineStorePreferences {
  @Field(() => String, {
    nullable: true,
    description:
      'Where its "Order on WhatsApp" links and WhatsApp section go, in E.164, such as ' +
      '+923001234567. Null until the shop sets one.',
  })
  whatsappNumber!: string | null;
}

@InputType()
export class OnlineStorePreferencesInput {
  @Field(() => String, {
    nullable: true,
    description:
      'A Pakistani mobile number, such as 0300 1234567; blank or null for none. Left as it is ' +
      'if not given.',
  })
  whatsappNumber?: string | null;
}

@ObjectType()
export class OnlineStorePreferencesUpdatePayload {
  @Field(() => OnlineStorePreferences, { nullable: true })
  preferences!: OnlineStorePreferences | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
