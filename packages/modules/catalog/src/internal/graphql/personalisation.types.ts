import { Money, UserError } from '@hatti/api';
import { Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum PersonalisationFieldKind {
  TEXT = 'TEXT',
  CHOICE = 'CHOICE',
}

registerEnumType(PersonalisationFieldKind, {
  name: 'PersonalisationFieldKind',
  description: 'What a personalisation field asks for: words the shopper writes, or a choice.',
});

@ObjectType({
  description:
    "What a product's page asks the shopper for when it is made to order (CAT-15, ADR-689): the " +
    "answer goes with the cart line as a property of the field's name, which the order's line " +
    'keeps as a custom attribute.',
})
export class PersonalisationField {
  @Field({ description: "What the page calls it, and the property's name." })
  name!: string;

  @Field(() => PersonalisationFieldKind)
  kind!: PersonalisationFieldKind;

  @Field({ description: 'Whether the page asks for an answer before adding to the cart.' })
  required!: boolean;

  @Field(() => Int, {
    nullable: true,
    description: 'The longest answer a text field takes; null for a choice.',
  })
  maxLength!: number | null;

  @Field(() => [String], { description: 'What a choice offers, in order; none for text.' })
  choices!: string[];

  @Field(() => Money, {
    nullable: true,
    description:
      "What an answer adds to each unit's price, as embroidery costs (ADR-697); null when it " +
      'adds nothing.',
  })
  price!: Money | null;
}

@InputType()
export class PersonalisationFieldInput {
  @Field({ description: 'At most 40 characters, not beginning "_", each field named once.' })
  name!: string;

  @Field(() => PersonalisationFieldKind)
  kind!: PersonalisationFieldKind;

  @Field(() => Boolean, { nullable: true, description: 'False unless given.' })
  required?: boolean | null;

  @Field(() => Int, {
    nullable: true,
    description: "A text field's longest answer, from 1 to 250; 50 unless given.",
  })
  maxLength?: number | null;

  @Field(() => [String], {
    nullable: true,
    description: "A choice's options, two to 20, each at most 40 characters, each once.",
  })
  choices?: string[] | null;

  @Field(() => String, {
    nullable: true,
    description:
      "What an answer adds to each unit's price, in the shop's currency, as 500 or 499.50; " +
      'nothing unless given.',
  })
  price?: string | null;
}

@ObjectType()
export class ProductPersonalisationSetPayload {
  @Field(() => [PersonalisationField], {
    nullable: true,
    description: 'The fields its page asks for now, in order; null when they could not be set.',
  })
  personalisationFields!: PersonalisationField[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
