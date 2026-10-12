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

@ObjectType({ description: "How a courier's API takes pickups (ADR-253)." })
export class CourierPickupSupport {
  @Field({
    description:
      'Whether it asks for the name and code of the rider who takes the parcels, as Leopards ' +
      'does: courierPickupRequest takes them.',
  })
  rider!: boolean;
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

  @Field(() => CourierPickupSupport, {
    nullable: true,
    description:
      'How its API takes pickups, through its own load sheet (ADR-253); null where it takes ' +
      "none, when the account's load sheet is printed for its rider.",
  })
  pickups!: CourierPickupSupport | null;

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

@ObjectType({
  description:
    'Which courier account books an order when staff name none (SHP-06, ADR-382): the first ' +
    "of the shop's rules that the order's city and the cash its courier is to collect match, " +
    "else the shop's default account.",
})
export class CourierRule {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, {
    nullable: true,
    description:
      "The account that books the orders it matches; null for the cheapest of the shop's " +
      'accounts by their rate cards for each order (ADR-385).',
  })
  accountId!: string | null;

  @Field({ description: 'Its account was archived since: the rule is passed over.' })
  accountArchived!: boolean;

  @Field(() => [String], {
    description: "Cities as Pakistan's list names them; none for anywhere.",
  })
  cities!: string[];

  @Field(() => Money, {
    nullable: true,
    description: 'The cash to collect is at least this; null for no least.',
  })
  codAtLeast!: Money | null;

  @Field(() => Money, {
    nullable: true,
    description: 'The cash to collect is below this; null for no most.',
  })
  codBelow!: Money | null;
}

@ObjectType({
  description:
    'The account an order would be booked with now without one named (ADR-382), and the rule ' +
    'that chose it.',
})
export class CourierAccountChoice {
  @Field(() => ID)
  orderId!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Null where no rule is for it and the shop has no default account.',
  })
  accountId!: string | null;

  @Field(() => ID, { nullable: true, description: "Null where it is the shop's default." })
  ruleId!: string | null;

  @Field(() => Money, {
    nullable: true,
    description:
      'What the parcel is likely to cost with that account if delivered, by its rate card: out ' +
      "and the courier's share of the cash (ADR-383). Null where the account has no card.",
  })
  chargeEstimate!: Money | null;
}

@ObjectType({
  description:
    'What a courier account charges (SHP-07, ADR-383): by the half kilo, within the city the ' +
    'shop ships from and to other cities; a share of the cash it collects; and a share of the ' +
    'charge again to bring a parcel back. Each parcel booked with the account is estimated by it.',
})
export class CourierRateCard {
  @Field(() => ID)
  accountId!: string;

  @Field({ description: "The city parcels go from, as Pakistan's list names it." })
  originCity!: string;

  @Field(() => Money, { description: 'The first half kilo, within the city.' })
  localFirst!: Money;

  @Field(() => Money, { description: 'Each half kilo after, within the city.' })
  localEach!: Money;

  @Field(() => Money, { description: 'The first half kilo, to other cities.' })
  otherFirst!: Money;

  @Field(() => Money, { description: 'Each half kilo after, to other cities.' })
  otherEach!: Money;

  @Field({ description: 'Percent of the cash collected, such as 2.5.' })
  codFeePercent!: number;

  @Field({ description: 'Percent of the charge again for a parcel brought back, such as 50.' })
  returnPercent!: number;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class CourierRateCardInput {
  @Field({ description: 'A city of Pakistan, as addresses name it.' })
  originCity!: string;

  @Field({ description: 'Decimal, e.g. "180".' })
  localFirst!: string;

  @Field()
  localEach!: string;

  @Field()
  otherFirst!: string;

  @Field()
  otherEach!: string;

  @Field(() => String, { nullable: true, description: 'Percent, 0 to 20, e.g. "2.5".' })
  codFeePercent?: string | null;

  @Field(() => String, { nullable: true, description: 'Percent, 0 to 200, e.g. "50".' })
  returnPercent?: string | null;
}

@ObjectType()
export class CourierRateCardPayload {
  @Field(() => CourierRateCard, { nullable: true })
  courierRateCard!: CourierRateCard | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CourierRateCardRemovePayload {
  @Field({ description: 'The card was taken away.' })
  removed!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@InputType()
export class CourierRuleInput {
  @Field(() => ID, {
    nullable: true,
    description:
      "The account that books the orders it matches; null for the cheapest of the shop's " +
      'accounts by their rate cards for each order, the rule passed over where none has a card.',
  })
  accountId?: string | null;

  @Field(() => [String], {
    nullable: true,
    description:
      'Cities of Pakistan, as addresses name them ("Pindi" is Rawalpindi); up to 100; none for ' +
      'anywhere.',
  })
  cities?: string[] | null;

  @Field(() => String, { nullable: true, description: 'Decimal, e.g. "20,000"; null for none.' })
  codAtLeast?: string | null;

  @Field(() => String, { nullable: true, description: 'Decimal; null for none.' })
  codBelow?: string | null;
}

@ObjectType()
export class CourierRulesUpdatePayload {
  @Field(() => [CourierRule], { nullable: true })
  courierRules!: CourierRule[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
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
  SHOPS = 'SHOPS',
  LIST = 'LIST',
  WRITTEN = 'WRITTEN',
}

registerEnumType(CourierCitySource, {
  name: 'CourierCitySource',
  description: "Where a courier's name for a city came from (SHP-03).",
  valuesMap: {
    SHOP: { description: "The shop's own name for the city with the courier." },
    PLATFORM: { description: "Hatti's name for the city with the courier, for every shop." },
    SHOPS: {
      description:
        'The name three shops or more gave the city alike with the courier, which no shop gave ' +
        "otherwise: every shop's, where neither the shop nor Hatti names the city (ADR-260).",
    },
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

export enum CourierPickupStatus {
  REQUESTING = 'REQUESTING',
  REQUESTED = 'REQUESTED',
  FAILED = 'FAILED',
}

registerEnumType(CourierPickupStatus, {
  name: 'CourierPickupStatus',
  description: 'What became of a pickup asked of a courier.',
  valuesMap: {
    REQUESTING: { description: 'Being asked of the courier now.' },
    REQUESTED: { description: 'The courier took it: its rider picks up the parcels.' },
    FAILED: {
      description:
        'The courier refused it, or never answered: see error. Its parcels go in the next.',
    },
  },
});

@ObjectType({
  description:
    "An account's parcels waiting to be picked up, handed to its courier through the courier's " +
    "API (SHP-02, ADR-253): PostEx's load sheet for the account's pickup address, or Leopards' " +
    'naming the rider who takes them.',
})
export class CourierPickup {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { description: 'The courier account whose parcels went.' })
  accountId!: string;

  @Field({ description: 'The courier\'s key, such as "postex".' })
  courier!: string;

  @Field({ description: 'Its name, such as "PostEx".' })
  courierName!: string;

  @Field(() => CourierPickupStatus)
  status!: CourierPickupStatus;

  @Field({
    description:
      "Handed to the courier's rider by hand and kept here alone, the courier not asked through " +
      'its API (ADR-378).',
  })
  byHand!: boolean;

  @Field(() => Int, { description: 'The parcels it handed over.' })
  parcelCount!: number;

  @Field(() => Int, {
    description:
      'Of them, those checked off as the rider took them, scanned from their labels (ADR-377).',
  })
  handedOverCount!: number;

  @Field(() => String, {
    nullable: true,
    description: "The courier's number for its load sheet, as Leopards gives one; null for none.",
  })
  reference!: string | null;

  @Field(() => String, { nullable: true, description: 'The rider who took them, where asked.' })
  riderName!: string | null;

  @Field(() => String, { nullable: true })
  riderCode!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "A URL that gives the courier's own load sheet, a PDF, for an hour, as PostEx makes one; " +
      'null where it gave none, when its portal prints it by its number.',
  })
  loadSheetUrl!: string | null;

  @Field(() => String, { nullable: true, description: 'What the courier said, when it refused.' })
  error!: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the courier took it; null until it did.',
  })
  requestedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@InputType()
export class CourierPickupInput {
  @Field(() => ID, {
    nullable: true,
    description: "The courier account whose parcels go; the shop's default unless given.",
  })
  accountId?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The name of the rider who takes the parcels, as the courier gave it, where it asks: up to ' +
      '100 characters.',
  })
  riderName?: string | null;

  @Field(() => String, {
    nullable: true,
    description: "The rider's code, as the courier gave it, where it asks: up to 100 characters.",
  })
  riderCode?: string | null;
}

@ObjectType()
export class CourierPickupPayload {
  @Field(() => CourierPickup, { nullable: true })
  courierPickup!: CourierPickup | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "One of a pickup's parcels, and whether its rider has taken it: checked off by scanning its " +
    'label as the rider takes it (SHP-02, APP-04, ADR-377).',
})
export class CourierPickupParcel {
  @Field(() => CourierBooking)
  booking!: CourierBooking;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When it was checked off as handed over; null while it is still to hand over.',
  })
  handedOverAt!: Date | null;
}

@ObjectType({
  description:
    "A parcel handed to a courier's rider that the courier's tracking still has as only booked a " +
    'day on (SHP-02, SHP-04, ADR-379): the rider may never have scanned it in, or lost it.',
})
export class CourierUnseenParcel {
  @Field(() => CourierBooking)
  booking!: CourierBooking;

  @Field(() => GraphQLISODateTime, { description: 'When it was checked off as handed over.' })
  handedOverAt!: Date;

  @Field(() => ID, { description: 'The pickup it was last handed over in.' })
  pickupId!: string;

  @Field(() => String, { nullable: true, description: "That pickup's rider, where named." })
  riderName!: string | null;

  @Field(() => String, { nullable: true })
  riderCode!: string | null;
}

@ObjectType({
  description:
    "A parcel's last hand-over to its courier's rider (SHP-02, SHP-04, ADR-381): when, in which " +
    "pickup and to whom, and what the courier's tracking has said of it since.",
})
export class ParcelHandOver {
  @Field(() => GraphQLISODateTime, { description: 'When it was checked off as handed over.' })
  handedOverAt!: Date;

  @Field(() => ID)
  pickupId!: string;

  @Field({ description: 'Handed to the rider by hand, its courier not asked (ADR-378).' })
  byHand!: boolean;

  @Field(() => String, { nullable: true, description: "The pickup's rider, where named." })
  riderName!: string | null;

  @Field(() => String, { nullable: true })
  riderCode!: string | null;

  @Field({ description: "The courier's tracking has had it as more than booked since." })
  seen!: boolean;

  @Field({
    description:
      "The courier's tracking still has it as only booked a day after it was handed over " +
      '(ADR-379): the rider may never have scanned it in, or lost it.',
  })
  unseen!: boolean;
}

@ObjectType()
export class CourierPickupParcelHandOverPayload {
  @Field(() => CourierPickupParcel, { nullable: true })
  parcel!: CourierPickupParcel | null;

  @Field({ description: 'The parcel had been checked off already, and stays as it was.' })
  alreadyHandedOver!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
