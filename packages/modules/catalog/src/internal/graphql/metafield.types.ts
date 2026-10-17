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

export enum MetafieldOwnerTypeValue {
  PRODUCT = 'product',
  PRODUCTVARIANT = 'variant',
  COLLECTION = 'collection',
}

registerEnumType(MetafieldOwnerTypeValue, {
  name: 'MetafieldOwnerType',
  description: 'What a metafield belongs to (ADR-489).',
});

@ObjectType({
  description:
    'Custom data on a product, variant or collection, as Shopify keeps it (ADR-489): a namespace, ' +
    'a key, a type and a value kept as a string.',
})
export class Metafield {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { description: 'The product, variant or collection it belongs to.' })
  ownerId!: string;

  @Field(() => MetafieldOwnerTypeValue)
  ownerType!: MetafieldOwnerTypeValue;

  @Field()
  namespace!: string;

  @Field()
  key!: string;

  @Field({
    description:
      'Its type: single_line_text_field, multi_line_text_field, number_integer, ' +
      'number_decimal, boolean, date, date_time, url, color, json or ' +
      'list.single_line_text_field.',
  })
  type!: string;

  @Field({ description: 'As a string; JSON for json and the list.' })
  value!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class MetafieldsSetInput {
  @Field(() => ID, { description: 'The product, variant or collection to set it on.' })
  ownerId!: string;

  @Field()
  namespace!: string;

  @Field()
  key!: string;

  @Field(() => String, {
    nullable: true,
    description: "Its type; its definition's when one names it, which it must agree with.",
  })
  type?: string | null;

  @Field()
  value!: string;
}

@ObjectType()
export class MetafieldsSetPayload {
  @Field(() => [Metafield], { nullable: true })
  metafields!: Metafield[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class MetafieldIdentifierInput {
  @Field(() => ID)
  ownerId!: string;

  @Field()
  namespace!: string;

  @Field()
  key!: string;
}

@ObjectType()
export class MetafieldIdentifier {
  @Field(() => ID)
  ownerId!: string;

  @Field()
  namespace!: string;

  @Field()
  key!: string;
}

@ObjectType()
export class MetafieldsDeletePayload {
  @Field(() => [MetafieldIdentifier], {
    nullable: true,
    description: 'Those it found and deleted.',
  })
  deletedMetafields!: MetafieldIdentifier[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "A field of the shop's own (ADR-489): its name for the admin, and the type its values take.",
})
export class MetafieldDefinition {
  @Field(() => ID)
  id!: string;

  @Field(() => MetafieldOwnerTypeValue)
  ownerType!: MetafieldOwnerTypeValue;

  @Field()
  namespace!: string;

  @Field()
  key!: string;

  @Field()
  type!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => Int, { description: 'How many owners of its kind have a value for it.' })
  metafieldsCount!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class MetafieldDefinitionInput {
  @Field(() => MetafieldOwnerTypeValue)
  ownerType!: MetafieldOwnerTypeValue;

  @Field()
  namespace!: string;

  @Field()
  key!: string;

  @Field()
  type!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description?: string | null;
}

@InputType()
export class MetafieldDefinitionUpdateInput {
  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;
}

@ObjectType()
export class MetafieldDefinitionCreatePayload {
  @Field(() => MetafieldDefinition, { nullable: true })
  createdDefinition!: MetafieldDefinition | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MetafieldDefinitionUpdatePayload {
  @Field(() => MetafieldDefinition, { nullable: true })
  updatedDefinition!: MetafieldDefinition | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MetafieldDefinitionDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedDefinitionId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
