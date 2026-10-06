import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import type { RefundReceiptRecord } from '../records.js';

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

@ObjectType({
  description:
    "A refund's receipt, which staff kept of the money they sent back by hand: a photo, a " +
    'screenshot or a PDF (ADR-242).',
})
export class RefundReceipt {
  @Field({ description: 'image/jpeg, image/png, image/webp or application/pdf.' })
  mimeType!: string;

  @Field(() => Int, { description: 'Bytes.' })
  fileSize!: number;

  /** Where storage keeps it, and what its URL names it for: its order and its refund's place. */
  record!: RefundReceiptRecord;
  orderNumber!: number;
  position!: number;
}
