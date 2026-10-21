import { UserError } from '@hatti/api';
import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    "How long a checkout holds its cart's stock once its shopper starts checking out (CHK-02, " +
    'ADR-715), so that in a drop the last pieces go to who reached checkout first.',
})
export class CheckoutStockHold {
  @Field(() => Int, {
    nullable: true,
    description:
      'Minutes, from 5 to 60; null for no holds. Units held are given back when the order takes ' +
      'them, when another checkout of the cart begins, or when the minutes run out.',
  })
  minutes!: number | null;
}

@ObjectType()
export class CheckoutStockHoldUpdatePayload {
  @Field(() => CheckoutStockHold, { nullable: true })
  checkoutStockHold!: CheckoutStockHold | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
