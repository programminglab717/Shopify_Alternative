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

export enum CourierBookingStatus {
  PENDING = 'PENDING',
  BOOKED = 'BOOKED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(CourierBookingStatus, {
  name: 'CourierBookingStatus',
  description: "What became of an order's booking with a courier.",
  valuesMap: {
    PENDING: {
      description:
        'Waiting to be booked: the courier is asked in turn, and again while it cannot answer.',
    },
    BOOKED: {
      description: 'The courier booked it, and the order shipped as a parcel with its number.',
    },
    FAILED: { description: 'The courier refused it, or the order could not ship: see error.' },
    CANCELLED: { description: 'Cancelled while it waited, or its account was archived.' },
  },
});

export enum CourierParcelStatus {
  BOOKED = 'BOOKED',
  IN_TRANSIT = 'IN_TRANSIT',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  ATTEMPTED = 'ATTEMPTED',
  DELIVERED = 'DELIVERED',
  RETURNING = 'RETURNING',
  RETURNED = 'RETURNED',
  LOST = 'LOST',
  CANCELLED = 'CANCELLED',
}

registerEnumType(CourierParcelStatus, {
  name: 'CourierParcelStatus',
  description: 'Where a booked parcel is, as Hatti reads what its courier says.',
  valuesMap: {
    BOOKED: { description: 'Booked, waiting to be picked up.' },
    IN_TRANSIT: { description: 'On its way.' },
    OUT_FOR_DELIVERY: { description: 'Out with a rider.' },
    ATTEMPTED: { description: 'A delivery was tried, and failed.' },
    DELIVERED: { description: 'Delivered: the parcel is marked delivered.' },
    RETURNING: { description: 'On its way back: the parcel is marked returning.' },
    RETURNED: {
      description: 'Back with the shop, says the courier: check it in to restock it.',
    },
    LOST: { description: 'The courier lost it.' },
    CANCELLED: { description: "The courier's booking was cancelled." },
  },
});

@ObjectType({ description: 'A credential a courier asks for, as its portal shows it.' })
export class CourierCredentialField {
  @Field({ description: 'What it goes by in CourierCredentialInput, such as "token".' })
  key!: string;

  @Field({ description: 'As staff know it, such as "API token".' })
  label!: string;
}

@ObjectType({ description: 'A courier shops book parcels with (SHP-01).' })
export class Courier {
  @Field({ description: 'Its key, such as "postex".' })
  courier!: string;

  @Field({ description: 'Its name, such as "PostEx".' })
  name!: string;

  @Field(() => [CourierCredentialField], { description: 'What connecting an account asks for.' })
  credentials!: CourierCredentialField[];

  @Field(() => String, {
    nullable: true,
    description: "What the courier calls its code for the shop's pickup address, if it has one.",
  })
  pickupCode!: string | null;

  @Field({ description: 'Books nothing with any courier: development and tests only.' })
  test!: boolean;
}

@ObjectType({
  description:
    "The shop's own account with a courier (SHP-01): its bookings are the shop's, and the " +
    'courier remits cash on delivery to the shop directly. Its credentials are never shown.',
})
export class CourierAccount {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The courier\'s key, such as "postex".' })
  courier!: string;

  @Field({ description: 'Such as "PostEx".' })
  courierName!: string;

  @Field({ description: 'As staff named it, such as "PostEx Lahore".' })
  name!: string;

  @Field({ description: "The last four characters of the account's first credential." })
  credentialsHint!: string;

  @Field(() => String, { nullable: true })
  pickupCode!: string | null;

  @Field({ description: 'Bookings that name no account are made with it.' })
  isDefault!: boolean;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'No bookings with it since; its parcels are still followed.',
  })
  archivedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class CourierCredentialInput {
  @Field({ description: "The credential's key, as Courier.credentials lists it." })
  key!: string;

  @Field({ description: 'As the courier gave it.' })
  value!: string;
}

@InputType()
export class CourierAccountInput {
  @Field(() => String, {
    nullable: true,
    description: 'The courier, by its key, such as "postex"; connecting only.',
  })
  courier?: string | null;

  @Field(() => String, { nullable: true, description: "The courier's name unless given." })
  name?: string | null;

  @Field(() => [CourierCredentialInput], {
    nullable: true,
    description: 'All the courier asks for: replacing them replaces every one.',
  })
  credentials?: CourierCredentialInput[] | null;

  @Field(() => String, { nullable: true, description: 'Blank takes it away.' })
  pickupCode?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description: "Make it the shop's default; the shop's first account is.",
  })
  isDefault?: boolean | null;
}

@ObjectType()
export class CourierAccountPayload {
  @Field(() => CourierAccount, { nullable: true })
  courierAccount!: CourierAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "An order's booking with a courier (SHP-02, SHP-04): waiting, then booked and followed " +
    'until its parcel is delivered or back.',
})
export class CourierBooking {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  orderId!: string;

  @Field({ description: 'Such as "#1043".' })
  orderName!: string;

  @Field(() => ID)
  accountId!: string;

  @Field({ description: 'Such as "PostEx".' })
  courierName!: string;

  @Field(() => CourierBookingStatus)
  status!: CourierBookingStatus;

  @Field(() => Int, { description: 'Tries at booking it with the courier.' })
  attempts!: number;

  @Field(() => String, {
    nullable: true,
    description: 'Why the last try failed, or why it was cancelled.',
  })
  error!: string | null;

  @Field(() => String, { nullable: true, description: "The courier's tracking number." })
  trackingNumber!: string | null;

  @Field(() => Money, {
    nullable: true,
    description: 'The cash the courier was asked to collect: what the order owed.',
  })
  codAmount!: Money | null;

  @Field(() => ID, { nullable: true, description: 'The parcel the order shipped as.' })
  fulfillmentId!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'What the courier last said of the parcel, as it said it.',
  })
  courierStatus!: string | null;

  @Field(() => CourierParcelStatus, { nullable: true })
  parcelStatus!: CourierParcelStatus | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When the courier last said.' })
  trackedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  bookedAt!: Date | null;

  @Field(() => GraphQLISODateTime, { description: 'When it was asked for.' })
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class CourierBookingEdge {
  @Field()
  cursor!: string;

  @Field(() => CourierBooking)
  node!: CourierBooking;
}

@ObjectType()
export class CourierBookingConnection {
  @Field(() => [CourierBookingEdge])
  edges!: CourierBookingEdge[];

  @Field(() => [CourierBooking])
  nodes!: CourierBooking[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class CourierBookingsArgs {
  @Field(() => Int, { nullable: true })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => CourierBookingStatus, { nullable: true })
  status?: CourierBookingStatus | null;

  @Field(() => ID, { nullable: true, description: "An order's bookings, the latest first." })
  orderId?: string | null;
}

@ObjectType({ description: 'An order not booked, and why.' })
export class OrderBookingRefusal {
  @Field(() => ID)
  orderId!: string;

  @Field()
  message!: string;
}

@ObjectType()
export class OrdersBookPayload {
  @Field(() => [CourierBooking], { description: 'The bookings made, waiting to be booked.' })
  bookings!: CourierBooking[];

  @Field(() => [OrderBookingRefusal])
  refused!: OrderBookingRefusal[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CourierBookingPayload {
  @Field(() => CourierBooking, { nullable: true })
  courierBooking!: CourierBooking | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({ description: "Couriers' labels or a load sheet, as one HTML page to print or save." })
export class CourierDocument {
  @Field({
    description:
      'A complete HTML page set up for the paper. It loads Inter and Noto Nastaliq Urdu from ' +
      'Google Fonts: print once `document.fonts.ready` resolves. It runs no scripts.',
  })
  html!: string;

  @Field({ description: 'For the browser tab, e.g. "Labels: 12 parcels".' })
  title!: string;

  @Field({ description: 'A name to save it as, e.g. "labels-1001-1012.html".' })
  fileName!: string;

  @Field(() => [CourierBooking], { description: 'The bookings in it, in the order printed.' })
  bookings!: CourierBooking[];
}

export enum CourierCitySource {
  SHOP = 'SHOP',
  PLATFORM = 'PLATFORM',
  LIST = 'LIST',
  WRITTEN = 'WRITTEN',
}

registerEnumType(CourierCitySource, {
  name: 'CourierCitySource',
  description: "Where a courier's name for a city came from (SHP-03).",
  valuesMap: {
    SHOP: { description: "The shop's own name for the city with the courier." },
    PLATFORM: { description: "Hatti's name for the city with the courier, for every shop." },
    LIST: {
      description:
        "The courier's list of cities it delivers to: the city as written, or Pakistan's name " +
        'for it or one of its others, such as "Pindi" for Rawalpindi.',
    },
    WRITTEN: {
      description:
        "The city as written, Pakistan's name for it where it has one: the courier publishes no " +
        'list of cities, or its list could not be had now.',
    },
  },
});

@ObjectType({
  description:
    "How a city matches a courier's names for the cities it delivers to (SHP-03): the name its " +
    'parcels are booked with, or the nearest names where it has none.',
})
export class CourierCityMatch {
  @Field({ description: 'The city as given.' })
  city!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "The courier's name for it, as parcels to it are booked; null where the courier's list " +
      'names none, and a booking to it fails.',
  })
  courierCity!: string | null;

  @Field(() => CourierCitySource, { nullable: true })
  source!: CourierCitySource | null;

  @Field(() => [String], {
    description:
      "The courier's names nearest to it, the nearest first, where its list names none: give " +
      'one with courierCityNameSet.',
  })
  suggestions!: string[];

  @Field(() => String, {
    nullable: true,
    description: "Why the courier's list of cities could not be had now, where it could not.",
  })
  listError!: string | null;
}

@ObjectType({
  description:
    "The shop's own name for a city with a courier (SHP-03): parcels to the city, as orders " +
    "write it or by Pakistan's name for it, are booked with it.",
})
export class CourierCityName {
  @Field({ description: 'The city as orders write it, such as "Pindi".' })
  city!: string;

  @Field({ description: "The courier's name for it, as its list writes it." })
  courierCity!: string;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class CourierCityNameInput {
  @Field(() => ID, { description: 'The courier account whose courier it is for.' })
  accountId!: string;

  @Field({ description: 'The city as orders write it, such as "Pindi".' })
  city!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "The courier's name for it, on its list of cities where it has one; null forgets the " +
      "shop's own.",
  })
  courierCity?: string | null;
}

@ObjectType()
export class CourierCityNamePayload {
  @Field(() => CourierCityMatch, {
    nullable: true,
    description: "How the city matches the courier's names now.",
  })
  match!: CourierCityMatch | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
