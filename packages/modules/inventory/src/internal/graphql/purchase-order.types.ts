import { Money, PageInfo, UserError } from '@hatti/api';
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

export enum PurchaseOrderStatus {
  OPEN = 'OPEN',
  RECEIVED = 'RECEIVED',
  CLOSED = 'CLOSED',
}

registerEnumType(PurchaseOrderStatus, {
  name: 'PurchaseOrderStatus',
  description: 'Where a purchase order is: goods still to come, or not.',
  valuesMap: {
    OPEN: { description: 'Goods still to come.' },
    RECEIVED: { description: 'Every line came in full.' },
    CLOSED: { description: 'Closed with what came; the rest is no longer expected.' },
  },
});

@ObjectType({ description: 'Someone the shop buys goods from.' })
export class Supplier {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true, description: 'A mobile number in E.164 form.' })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType({ description: 'A variant ordered from a supplier, as it was named when ordered.' })
export class PurchaseOrderLine {
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

  @Field(() => Int, { description: 'How many came so far.' })
  received!: number;

  @Field(() => Money, { nullable: true, description: 'What one costs, where the shop said.' })
  unitCost!: Money | null;

  /** The variant, for its item. */
  variantId!: string;
}

@ObjectType({
  description:
    'Goods ordered from a supplier for a location, received into stock there as they come.',
})
export class PurchaseOrder {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'PO-1 onwards, per shop.' })
  name!: string;

  @Field(() => Int)
  number!: number;

  @Field(() => PurchaseOrderStatus)
  status!: PurchaseOrderStatus;

  @Field(() => Supplier)
  supplier!: Supplier;

  @Field(() => Location, { description: 'Where the goods are received.' })
  location!: Location;

  @Field(() => String, { nullable: true, description: "The supplier's own number for it." })
  reference!: string | null;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'The day the goods are expected, YYYY-MM-DD.',
  })
  expectedOn!: string | null;

  @Field(() => [PurchaseOrderLine])
  lines!: PurchaseOrderLine[];

  @Field(() => Int)
  totalQuantity!: number;

  @Field(() => Int)
  receivedQuantity!: number;

  @Field(() => Money, {
    nullable: true,
    description: 'What the lines with a cost come to; null when none has one.',
  })
  totalCost!: Money | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was received in full or closed.',
  })
  closedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class PurchaseOrderEdge {
  @Field()
  cursor!: string;

  @Field(() => PurchaseOrder)
  node!: PurchaseOrder;
}

@ObjectType()
export class PurchaseOrderConnection {
  @Field(() => [PurchaseOrderEdge])
  edges!: PurchaseOrderEdge[];

  @Field(() => [PurchaseOrder])
  nodes!: PurchaseOrder[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class PurchaseOrdersArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => PurchaseOrderStatus, { nullable: true })
  status?: PurchaseOrderStatus | null;

  @Field(() => ID, { nullable: true })
  supplierId?: string | null;
}

@InputType()
export class SupplierInput {
  @Field(() => String, {
    nullable: true,
    description: 'Required to add one; up to 255 characters.',
  })
  name?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A Pakistani mobile number; null clears it.',
  })
  phone?: string | null;

  @Field(() => String, { nullable: true, description: 'Null clears it.' })
  note?: string | null;
}

@InputType()
export class PurchaseOrderLineInput {
  @Field(() => ID)
  inventoryItemId!: string;

  @Field(() => Int, { description: '1 or more.' })
  quantity!: number;

  @Field(() => String, {
    nullable: true,
    description: 'What one costs, in major units of the shop currency, e.g. "1450".',
  })
  unitCost?: string | null;
}

@InputType()
export class PurchaseOrderCreateInput {
  @Field(() => ID)
  supplierId!: string;

  @Field(() => ID, { description: 'An active location, where the goods are received.' })
  locationId!: string;

  @Field(() => String, { nullable: true, description: "The supplier's own number for it." })
  reference?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => String, { nullable: true, description: 'The day expected, YYYY-MM-DD.' })
  expectedOn?: string | null;

  @Field(() => [PurchaseOrderLineInput], { description: '1 to 250; each item once.' })
  lines!: PurchaseOrderLineInput[];
}

@InputType()
export class PurchaseOrderReceiveLineInput {
  @Field(() => ID)
  lineId!: string;

  @Field(() => Int, { description: 'How many came: 1 to as many as are still to come.' })
  quantity!: number;
}

@InputType()
export class PurchaseOrderReceiveInput {
  @Field(() => [PurchaseOrderReceiveLineInput], { description: '1 to 250; each line once.' })
  lines!: PurchaseOrderReceiveLineInput[];
}

@ObjectType()
export class SupplierPayload {
  @Field(() => Supplier, { nullable: true })
  supplier!: Supplier | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PurchaseOrderPayload {
  @Field(() => PurchaseOrder, { nullable: true })
  purchaseOrder!: PurchaseOrder | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
