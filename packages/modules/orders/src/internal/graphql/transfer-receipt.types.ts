import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description:
    "A receipt for a bank transfer, which the customer sent through their order's page: a " +
    'photo, a screenshot or a PDF (ADR-080).',
})
export class TransferReceipt {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'image/jpeg, image/png, image/webp or application/pdf.' })
  mimeType!: string;

  @Field(() => Int, { description: 'Bytes.' })
  fileSize!: number;

  @Field({
    description:
      'Where it is shown, for an hour from when it was asked for, named for its order: ' +
      '"Receipt #1023-1.jpg".',
  })
  url!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}
