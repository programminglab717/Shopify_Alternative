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

  @Field({
    description:
      'Whether the storefront is closed behind its password: shoppers see only its password ' +
      'page until they give it, as while a new shop gets ready to open.',
  })
  passwordEnabled!: boolean;

  @Field(() => String, {
    nullable: true,
    description: "The storefront's password, to give those who may see it. Null until one is set.",
  })
  password!: string | null;

  @Field({ description: 'What the password page tells shoppers; empty for nothing.' })
  passwordMessage!: string;
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

  @Field(() => Boolean, {
    nullable: true,
    description:
      'Closes the storefront behind its password, which must be set, or opens it. Left as it ' +
      'is if not given.',
  })
  passwordEnabled?: boolean | null;

  @Field(() => String, {
    nullable: true,
    description:
      "The storefront's password, 4 to 100 characters. Changed, never taken away: shoppers who " +
      'gave the old one are asked for the new.',
  })
  password?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'What the password page tells shoppers, up to 1,000 characters; blank for nothing.',
  })
  passwordMessage?: string | null;
}

@ObjectType()
export class OnlineStorePreferencesUpdatePayload {
  @Field(() => OnlineStorePreferences, { nullable: true })
  preferences!: OnlineStorePreferences | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
