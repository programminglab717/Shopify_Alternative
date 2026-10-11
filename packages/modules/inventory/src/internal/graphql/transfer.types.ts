import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { Location } from './location.types.js';

export enum InventoryTransferStatus {
  IN_TRANSIT = 'IN_TRANSIT',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(InventoryTransferStatus, {
  name: 'InventoryTransferStatus',
  description: 'Where a transfer is: stock still on its way, or not.',
  valuesMap: {
    IN_TRANSIT: { description: 'Sent; some or all of it still on its way.' },
    RECEIVED: { description: 'Every line arrived in full.' },
    CANCELLED: { description: 'What had not arrived went back where it left.' },
  },
});

@ObjectType({ description: 'A variant sent between locations, as it was named when sent.' })
export class InventoryTransferLine {
  @Field(() => ID)
  id!: string;

  @Field()
  productTitle!: string;

  @Field()
  variantTitle!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Int, { description: 'How many arrived so far.' })
  received!: number;

  /** The variant, for its item. */
  variantId!: string;
}

@ObjectType({
  description:
    "Stock sent from one of the shop's locations to another, on its way until it is received.",
})
export class InventoryTransfer {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'T-1 onwards, per shop.' })
  name!: string;

  @Field(() => Int)
  number!: number;

  @Field(() => InventoryTransferStatus)
  status!: InventoryTransferStatus;

  @Field(() => Location, { description: 'Where the stock left from.' })
  origin!: Location;

  @Field(() => Location, { description: 'Where the stock goes.' })
  destination!: Location;

  @Field(() => String, {
    nullable: true,
    description: "Such as the courier's tracking number, or the bilty of the goods transport.",
  })
  reference!: string | null;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => [InventoryTransferLine])
  lines!: InventoryTransferLine[];

  @Field(() => Int)
  totalQuantity!: number;

  @Field(() => Int)
  receivedQuantity!: number;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was received in full or cancelled.',
  })
  closedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { description: 'When it was sent.' })
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class InventoryTransferEdge {
  @Field()
  cursor!: string;

  @Field(() => InventoryTransfer)
  node!: InventoryTransfer;
}

@ObjectType()
export class InventoryTransferConnection {
  @Field(() => [InventoryTransferEdge])
  edges!: InventoryTransferEdge[];

  @Field(() => [InventoryTransfer])
  nodes!: InventoryTransfer[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class InventoryTransfersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => InventoryTransferStatus, { nullable: true })
  status?: InventoryTransferStatus | null;

  @Field(() => ID, { nullable: true, description: 'Those leaving from or going to it.' })
  locationId?: string | null;
}

@InputType()
export class InventoryTransferLineInput {
  @Field(() => ID)
  inventoryItemId!: string;

  @Field(() => Int, { description: '1 to as many as are available where it leaves.' })
  quantity!: number;
}

@InputType()
export class InventoryTransferCreateInput {
  @Field(() => ID, { description: 'An active location, where the stock leaves from.' })
  originId!: string;

  @Field(() => ID, { description: 'Another active location, where it goes.' })
  destinationId!: string;

  @Field(() => String, {
    nullable: true,
    description: "Such as the courier's tracking number; up to 255 characters.",
  })
  reference?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [InventoryTransferLineInput], { description: '1 to 250; each item once.' })
  lines!: InventoryTransferLineInput[];
}

@InputType()
export class InventoryTransferReceiveLineInput {
  @Field(() => ID)
  lineId!: string;

  @Field(() => Int, { description: 'How many arrived: 1 to as many as are still on the way.' })
  quantity!: number;
}

@InputType()
export class InventoryTransferReceiveInput {
  @Field(() => [InventoryTransferReceiveLineInput], { description: '1 to 250; each line once.' })
  lines!: InventoryTransferReceiveLineInput[];
}

@ObjectType()
export class InventoryTransferPayload {
  @Field(() => InventoryTransfer, { nullable: true })
  inventoryTransfer!: InventoryTransfer | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
