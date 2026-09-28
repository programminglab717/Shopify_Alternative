import { PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
} from '@nestjs/graphql';

@ObjectType({ description: 'A postal address in Pakistan.' })
export class LocationAddress {
  @Field(() => String, { nullable: true })
  address1!: string | null;

  @Field(() => String, { nullable: true })
  address2!: string | null;

  @Field(() => String, { nullable: true })
  city!: string | null;

  @Field(() => String, { nullable: true, description: 'Province or territory, e.g. "Punjab".' })
  province!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'ISO 3166-2:PK subdivision code without the country, e.g. "PB".',
  })
  provinceCode!: string | null;

  @Field(() => String, { nullable: true, description: 'Five-digit postcode.' })
  zip!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Mobile number in E.164 form, e.g. "+923001234567".',
  })
  phone!: string | null;

  @Field(() => [String], { description: 'The address as lines to print; empty parts left out.' })
  formatted!: string[];
}

@ObjectType({ description: 'A place where stock is kept, such as a warehouse or a shop.' })
export class Location {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => LocationAddress)
  address!: LocationAddress;

  @Field({ description: 'Inactive locations hold no stock and are left out of stock totals.' })
  isActive!: boolean;

  @Field({ description: 'The first location; it cannot be deactivated or deleted.' })
  isPrimary!: boolean;

  @Field({ description: 'Whether online orders can be sent from here, so its stock sells online.' })
  fulfillsOnlineOrders!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  deactivatedAt!: Date | null;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class LocationEdge {
  @Field()
  cursor!: string;

  @Field(() => Location)
  node!: Location;
}

@ObjectType()
export class LocationConnection {
  @Field(() => [LocationEdge])
  edges!: LocationEdge[];

  @Field(() => [Location])
  nodes!: Location[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class LocationsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field({ defaultValue: false, description: 'Include deactivated locations.' })
  includeInactive!: boolean;
}

@InputType({ description: 'Fields left out stay as they are; null or "" clears one.' })
export class LocationAddressInput {
  @Field(() => String, { nullable: true })
  address1?: string | null;

  @Field(() => String, { nullable: true })
  address2?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Known cities are spelled the standard way: "lhr" becomes "Lahore".',
  })
  city?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Province or territory: its code ("PB"), name ("Punjab") or a common alias ("KPK"). ' +
      'Taken from the city when left out and the city is known.',
  })
  province?: string | null;

  @Field(() => String, { nullable: true, description: 'Five-digit postcode, e.g. "54000".' })
  zip?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Mobile number for courier pickups, in any common format.',
  })
  phone?: string | null;
}

@InputType()
export class LocationAddInput {
  @Field()
  name!: string;

  @Field(() => LocationAddressInput, { nullable: true })
  address?: LocationAddressInput | null;

  @Field(() => Boolean, { nullable: true, description: 'Default true.' })
  fulfillsOnlineOrders?: boolean | null;
}

@InputType({ description: 'Fields left out stay as they are.' })
export class LocationEditInput {
  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => LocationAddressInput, { nullable: true })
  address?: LocationAddressInput | null;

  @Field(() => Boolean, { nullable: true })
  fulfillsOnlineOrders?: boolean | null;
}

@ObjectType()
export class LocationAddPayload {
  @Field(() => Location, { nullable: true })
  location!: Location | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class LocationEditPayload {
  @Field(() => Location, { nullable: true })
  location!: Location | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class LocationDeactivatePayload {
  @Field(() => Location, { nullable: true })
  location!: Location | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class LocationActivatePayload {
  @Field(() => Location, { nullable: true })
  location!: Location | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class LocationDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedLocationId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
