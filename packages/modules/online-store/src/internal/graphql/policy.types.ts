import { UserError } from '@hatti/api';
import {
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

/** A shop's policies, as Shopify names them, each with the value the online store keeps. */
export enum ShopPolicyType {
  REFUND_POLICY = 'refund_policy',
  PRIVACY_POLICY = 'privacy_policy',
  TERMS_OF_SERVICE = 'terms_of_service',
  SHIPPING_POLICY = 'shipping_policy',
  CONTACT_INFORMATION = 'contact_information',
}

registerEnumType(ShopPolicyType, {
  name: 'ShopPolicyType',
  description: "A shop's policies, as Shopify names them.",
});

@ObjectType({
  description:
    "One of the shop's policies, shown on the storefront at its url and linked from the " +
    "theme's footer.",
})
export class ShopPolicy {
  @Field(() => ID)
  id!: string;

  @Field(() => ShopPolicyType)
  type!: ShopPolicyType;

  @Field({ description: 'As Shopify titles it: "Refund policy".' })
  title!: string;

  @Field({ description: 'HTML, cleaned of anything that could run when it was saved.' })
  body!: string;

  @Field({ description: 'Where the storefront shows it: /policies/refund-policy at its address.' })
  url!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class ShopPolicyInput {
  @Field(() => ShopPolicyType)
  type!: ShopPolicyType;

  @Field({ description: 'HTML, cleaned before it is kept. Blank takes the policy away.' })
  body!: string;
}

@ObjectType()
export class ShopPolicyUpdatePayload {
  @Field(() => ShopPolicy, { nullable: true, description: 'Null once it is taken away.' })
  shopPolicy!: ShopPolicy | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'A first draft of a policy, filled in from what the shop has set, for it to read, change ' +
    'and save with shopPolicyUpdate. Not legal advice.',
})
export class ShopPolicyDraft {
  @Field(() => ShopPolicyType)
  type!: ShopPolicyType;

  @Field()
  title!: string;

  @Field({ description: 'HTML.' })
  body!: string;
}
