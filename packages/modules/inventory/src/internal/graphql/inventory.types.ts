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
import { ADJUSTMENT_REASONS, MOVE_REASONS, SETTABLE_NAMES } from '../rules.js';
import { Location } from './location.types.js';

export enum InventoryPolicy {
  DENY = 'DENY',
  CONTINUE = 'CONTINUE',
}

registerEnumType(InventoryPolicy, {
  name: 'InventoryPolicy',
  description: 'What happens when a tracked item has nothing available.',
  valuesMap: {
    DENY: { description: 'Stop selling it.' },
    CONTINUE: { description: 'Keep selling it; available goes below zero.' },
  },
});

const NAME_DESCRIPTION =
  `Which quantity: ${SETTABLE_NAMES.map((name) => `"${name}"`).join(', ')}. ` +
  'Changing "available" changes on hand by the same amount.';

const REASON_DESCRIPTION = `Why: ${ADJUSTMENT_REASONS.map((reason) => `"${reason}"`).join(', ')}.`;

const URI_DESCRIPTION =
  'What caused it, as a URI: a delivery note in another system, for example. Shown in history.';

@ObjectType({ description: "An item's quantities at one location." })
export class InventoryLevel {
  @Field(() => ID)
  id!: string;

  @Field(() => Location)
  location!: Location;

  @Field(() => Int, {
    description: 'What can still be sold: on hand less committed, reserved and safety stock.',
  })
  available!: number;

  @Field(() => Int, { description: 'Units at the location.' })
  onHand!: number;

  @Field(() => Int, { description: 'Promised to placed orders not yet fulfilled.' })
  committed!: number;

  @Field(() => Int, { description: 'Held for checkouts in progress.' })
  reserved!: number;

  @Field(() => Int, { description: 'Kept back, never sold online.' })
  safetyStock!: number;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType({
  description:
    "How a variant's stock is counted, and where it is. Every variant has one; its ID differs " +
    "from the variant's.",
})
export class InventoryItem {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'Whether sales are checked against stock. Recording stock turns it on.' })
  tracked!: boolean;

  @Field(() => InventoryPolicy)
  inventoryPolicy!: InventoryPolicy;

  @Field(() => [InventoryLevel], {
    description: 'Levels at active locations it was ever stocked at: primary first, then by name.',
  })
  inventoryLevels!: InventoryLevel[];

  /** The variant, for field resolvers. */
  variantId!: string;
}

@ObjectType({ description: 'One quantity changed by an adjustment.' })
export class InventoryChange {
  @Field({ description: 'The quantity: "on_hand", "committed", "reserved" or "safety_stock".' })
  name!: string;

  @Field(() => Int)
  delta!: number;

  @Field(() => Int)
  quantityAfterChange!: number;

  @Field(() => Int, { description: 'Available at the location after the adjustment.' })
  availableAfterChange!: number;

  @Field(() => Location)
  location!: Location;

  @Field({ description: 'Why, e.g. "received", "committed" (an order) or "fulfilled".' })
  reason!: string;

  @Field(() => String, { nullable: true })
  referenceDocumentUri!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  /** The variant, for field resolvers. */
  variantId!: string;
}

@ObjectType({ description: 'One change of stock and why, with the quantities it changed.' })
export class InventoryAdjustmentGroup {
  @Field(() => ID)
  id!: string;

  @Field()
  reason!: string;

  @Field(() => String, { nullable: true })
  referenceDocumentUri!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => [InventoryChange])
  changes!: InventoryChange[];
}

@ObjectType()
export class InventoryChangeEdge {
  @Field()
  cursor!: string;

  @Field(() => InventoryChange)
  node!: InventoryChange;
}

@ObjectType()
export class InventoryChangeConnection {
  @Field(() => [InventoryChangeEdge])
  edges!: InventoryChangeEdge[];

  @Field(() => [InventoryChange])
  nodes!: InventoryChange[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class InventoryChangesArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => ID, { nullable: true, description: 'Only changes at this location.' })
  locationId?: string | null;
}

@InputType()
export class InventoryItemInput {
  @Field(() => Boolean, { nullable: true })
  tracked?: boolean | null;

  @Field(() => InventoryPolicy, { nullable: true })
  inventoryPolicy?: InventoryPolicy | null;
}

@InputType()
export class InventoryChangeInput {
  @Field(() => ID)
  inventoryItemId!: string;

  @Field(() => ID)
  locationId!: string;

  @Field(() => Int, { description: 'Units to add; negative takes away.' })
  delta!: number;
}

@InputType()
export class InventoryAdjustQuantitiesInput {
  @Field({ description: NAME_DESCRIPTION })
  name!: string;

  @Field({ description: REASON_DESCRIPTION })
  reason!: string;

  @Field(() => String, { nullable: true, description: URI_DESCRIPTION })
  referenceDocumentUri?: string | null;

  @Field(() => [InventoryChangeInput], { description: 'Up to 250; each item and location once.' })
  changes!: InventoryChangeInput[];
}

@InputType()
export class InventoryQuantityInput {
  @Field(() => ID)
  inventoryItemId!: string;

  @Field(() => ID)
  locationId!: string;

  @Field(() => Int, { description: 'The new quantity, 0 or more.' })
  quantity!: number;

  @Field(() => Int, {
    nullable: true,
    description:
      'The quantity as last read. If it has changed since, this quantity is not set and the ' +
      'error has code STALE. Leave out to set it regardless.',
  })
  compareQuantity?: number | null;
}

@InputType()
export class InventorySetQuantitiesInput {
  @Field({ description: NAME_DESCRIPTION })
  name!: string;

  @Field({ description: REASON_DESCRIPTION })
  reason!: string;

  @Field(() => String, { nullable: true, description: URI_DESCRIPTION })
  referenceDocumentUri?: string | null;

  @Field(() => [InventoryQuantityInput], { description: 'Up to 250; each item and location once.' })
  quantities!: InventoryQuantityInput[];
}

@InputType({ description: 'One end of a move: where stock leaves or arrives.' })
export class InventoryMoveQuantityTerminalInput {
  @Field(() => ID)
  locationId!: string;

  @Field({ description: 'Which quantity: only "available".' })
  name!: string;
}

@InputType()
export class InventoryMoveQuantityChange {
  @Field(() => ID)
  inventoryItemId!: string;

  @Field(() => Int, { description: 'Units to move, 1 or more.' })
  quantity!: number;

  @Field(() => InventoryMoveQuantityTerminalInput, {
    description: 'Where it leaves: as much must be available there.',
  })
  from!: InventoryMoveQuantityTerminalInput;

  @Field(() => InventoryMoveQuantityTerminalInput, {
    description: 'Where it arrives: another location.',
  })
  to!: InventoryMoveQuantityTerminalInput;
}

@InputType()
export class InventoryMoveQuantitiesInput {
  @Field({
    description: `Why: ${MOVE_REASONS.map((reason) => `"${reason}"`).join(', ')}.`,
  })
  reason!: string;

  @Field(() => String, { nullable: true, description: URI_DESCRIPTION })
  referenceDocumentUri?: string | null;

  @Field(() => [InventoryMoveQuantityChange], {
    description: 'Up to 250; each item and location once.',
  })
  changes!: InventoryMoveQuantityChange[];
}

@ObjectType()
export class InventoryItemUpdatePayload {
  @Field(() => InventoryItem, { nullable: true })
  inventoryItem!: InventoryItem | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class InventoryAdjustQuantitiesPayload {
  @Field(() => InventoryAdjustmentGroup, {
    nullable: true,
    description: 'Null when there were errors, or nothing changed.',
  })
  inventoryAdjustmentGroup!: InventoryAdjustmentGroup | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class InventorySetQuantitiesPayload {
  @Field(() => InventoryAdjustmentGroup, {
    nullable: true,
    description: 'Null when there were errors, or nothing changed.',
  })
  inventoryAdjustmentGroup!: InventoryAdjustmentGroup | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class InventoryMoveQuantitiesPayload {
  @Field(() => InventoryAdjustmentGroup, {
    nullable: true,
    description: 'Null when there were errors.',
  })
  inventoryAdjustmentGroup!: InventoryAdjustmentGroup | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
