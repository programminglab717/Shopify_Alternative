import { UserError } from '@hatti/api';
import { Field, ObjectType } from '@nestjs/graphql';
import { Product } from './product.types.js';

@ObjectType()
export class ProductComplementsSetPayload {
  @Field(() => [Product], {
    nullable: true,
    description: 'The products it pairs with now, in order; null when it could not be set.',
  })
  complementaryProducts!: Product[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
