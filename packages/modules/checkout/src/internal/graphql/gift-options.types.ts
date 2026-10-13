import { Money, UserError } from '@hatti/api';
import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'The variant a shop sells as gift wrap, as the catalog has it now.' })
export class CheckoutGiftWrap {
  @Field(() => ID)
  variantId!: string;

  @Field()
  productTitle!: string;

  @Field()
  variantTitle!: string;

  @Field(() => Money, { description: 'What checkout adds to the order for it.' })
  price!: Money;

  @Field({ description: 'Whether its product is active: checkout offers it only then.' })
  forSale!: boolean;
}

@ObjectType({ description: 'What the checkout offers to send a gift with (CHK-16, ADR-413).' })
export class CheckoutGiftOptions {
  @Field(() => CheckoutGiftWrap, {
    nullable: true,
    description:
      "The shop's own variant the checkout's page adds to the cart when a shopper asks for gift " +
      'wrap, at its price; null for none, or once it is deleted.',
  })
  wrap!: CheckoutGiftWrap | null;

  @Field({
    description:
      'Whether the page asks for a gift message, which the order keeps for its packing slip.',
  })
  messages!: boolean;
}

@InputType()
export class CheckoutGiftOptionsInput {
  @Field(() => ID, {
    nullable: true,
    description: "One of the shop's variants to sell as gift wrap; null for none.",
  })
  wrapVariantId?: string | null;

  @Field()
  messages!: boolean;
}

@ObjectType()
export class CheckoutGiftOptionsUpdatePayload {
  @Field(() => CheckoutGiftOptions, { nullable: true })
  checkoutGiftOptions!: CheckoutGiftOptions | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
