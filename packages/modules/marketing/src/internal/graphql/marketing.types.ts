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

export enum ConversionMoment {
  PLACED = 'PLACED',
  CONFIRMED = 'CONFIRMED',
  DELIVERED = 'DELIVERED',
}

registerEnumType(ConversionMoment, {
  name: 'ConversionMoment',
  description: 'A moment of an order placed through checkout that the ad platforms hear of.',
  valuesMap: {
    PLACED: { description: 'It was placed.' },
    CONFIRMED: {
      description: 'Its customer or staff confirmed it; or, paid ahead, its payment came in.',
    },
    DELIVERED: { description: 'Its parcel was delivered.' },
  },
});

export enum ConversionStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  SKIPPED = 'SKIPPED',
}

registerEnumType(ConversionStatus, {
  name: 'ConversionStatus',
  description: 'How sending a moment to an ad platform went.',
  valuesMap: {
    PENDING: { description: 'Waiting to go, or to be tried again.' },
    SENT: { description: 'The platform took it.' },
    FAILED: { description: 'The platform refused it, for good: `error` says why.' },
    EXPIRED: {
      description:
        'Too old for the platform by the time it could go: Meta and TikTok take seven days, ' +
        'Google three.',
    },
    SKIPPED: {
      description:
        "Not sent: the shop disconnected the platform, or the customer's data was erased.",
    },
  },
});

export enum ConversionPlatform {
  META = 'META',
  TIKTOK = 'TIKTOK',
  GOOGLE = 'GOOGLE',
}

registerEnumType(ConversionPlatform, {
  name: 'ConversionPlatform',
  description: 'An ad platform orders go to.',
  valuesMap: {
    META: { description: "Meta's conversions API, for Facebook's and Instagram's ads." },
    TIKTOK: { description: "TikTok's Events API, for TikTok's ads (ADR-541)." },
    GOOGLE: {
      description: "Google Analytics' Measurement Protocol, for Google's ads (ADR-547).",
    },
  },
});

@ObjectType({
  description:
    "The shop's Meta dataset, which its orders placed through checkout go to through Meta's " +
    'conversions API as they are placed, confirmed and delivered (MKT-10, ADR-143).',
})
export class MetaConversions {
  @Field({ description: "The dataset's ID: its Meta pixel's, as Events Manager shows it." })
  pixelId!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'The last four characters of its access token, never shown again; null with the pixel ' +
      'alone, which the storefront loads while orders go to no conversions API (ADR-531).',
  })
  accessTokenHint!: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Events Manager's code for test events: while it is set, Events Manager shows the " +
      "shop's events among them as they come.",
  })
  testEventCode!: string | null;

  @Field(() => ConversionMoment, {
    description:
      "Which moment of an order is Meta's Purchase; the others go as OrderPlaced, " +
      'OrderConfirmed and OrderDelivered. DELIVERED counts only the sales that turned out.',
  })
  purchaseAt!: ConversionMoment;

  @Field({
    description:
      "Whether orders the shop's staff take go to Meta too (ADR-655), as checkout's do: from " +
      'WhatsApp, Instagram and Facebook as chat events, from the counter as physical store ' +
      "ones, and the rest taken by hand as other ones. TikTok and Google hear of checkout's alone.",
  })
  staffOrders!: boolean;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class MetaConversionsInput {
  @Field(() => String, {
    nullable: true,
    description: "The dataset's ID, from Events Manager: needed to connect.",
  })
  pixelId?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'An access token Events Manager made for the conversions API, on plans with it: kept ' +
      'sealed, and never shown again. Without one, the storefront loads the pixel alone ' +
      '(ADR-531).',
  })
  accessToken?: string | null;

  @Field(() => String, {
    nullable: true,
    description: "Events Manager's code for test events; blank or null takes it away.",
  })
  testEventCode?: string | null;

  @Field(() => ConversionMoment, { nullable: true, description: 'PLACED unless set.' })
  purchaseAt?: ConversionMoment | null;

  @Field(() => Boolean, { nullable: true, description: 'false unless set.' })
  staffOrders?: boolean | null;
}

@ObjectType()
export class MetaConversionsUpdatePayload {
  @Field(() => MetaConversions, { nullable: true })
  metaConversions!: MetaConversions | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MetaConversionsDeletePayload {
  @Field(() => String, {
    nullable: true,
    description: "The dataset's ID that was connected; null when none was.",
  })
  deletedPixelId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "The shop's TikTok pixel, which its orders placed through checkout go to through TikTok's " +
    'Events API as they are placed, confirmed and delivered (MKT-10, ADR-541).',
})
export class TikTokEvents {
  @Field({ description: "The pixel's code, as TikTok's Events Manager shows it." })
  pixelCode!: string;

  @Field({ description: 'The last four characters of its access token, never shown again.' })
  accessTokenHint!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "Events Manager's code for test events: while it is set, Events Manager shows the " +
      "shop's events among them as they come.",
  })
  testEventCode!: string | null;

  @Field(() => ConversionMoment, {
    description:
      "Which moment of an order is TikTok's CompletePayment; the others go as PlaceAnOrder, " +
      'OrderConfirmed and OrderDelivered. DELIVERED counts only the sales that turned out.',
  })
  purchaseAt!: ConversionMoment;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class TikTokEventsInput {
  @Field(() => String, {
    nullable: true,
    description: "The pixel's code, from TikTok's Events Manager: needed to connect.",
  })
  pixelCode?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'An access token Events Manager made for the Events API: needed to connect, kept sealed, ' +
      'and never shown again.',
  })
  accessToken?: string | null;

  @Field(() => String, {
    nullable: true,
    description: "Events Manager's code for test events; blank or null takes it away.",
  })
  testEventCode?: string | null;

  @Field(() => ConversionMoment, { nullable: true, description: 'PLACED unless set.' })
  purchaseAt?: ConversionMoment | null;
}

@ObjectType()
export class TikTokEventsUpdatePayload {
  @Field(() => TikTokEvents, { nullable: true })
  tiktokEvents!: TikTokEvents | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class TikTokEventsDeletePayload {
  @Field(() => String, {
    nullable: true,
    description: "The pixel's code that was connected; null when none was.",
  })
  deletedPixelCode!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    'A moment of an order placed through checkout, sent or to be sent to an ad platform, and ' +
    'how sending it went.',
})
export class ConversionEvent {
  @Field(() => ID)
  id!: string;

  @Field(() => ConversionPlatform)
  platform!: ConversionPlatform;

  @Field(() => ID)
  orderId!: string;

  @Field(() => ConversionMoment)
  moment!: ConversionMoment;

  @Field(() => GraphQLISODateTime, {
    description: 'When it happened: the time the platform hears.',
  })
  occurredAt!: Date;

  @Field(() => ConversionStatus)
  status!: ConversionStatus;

  @Field(() => String, {
    nullable: true,
    description:
      'The name it went by once sent: Purchase, or its moment\'s own, as "OrderDelivered".',
  })
  eventName!: string | null;

  @Field(() => Int, { description: 'Tries to send it so far.' })
  attempts!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  sentAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'What the platform said last, when it did not take it: why.',
  })
  error!: string | null;

  @Field(() => String, {
    nullable: true,
    description: "The trace of the platform's answer, to ask it about: Meta's fbtrace_id.",
  })
  traceId!: string | null;

  @Field(() => GraphQLISODateTime, { description: 'When it was recorded.' })
  createdAt!: Date;
}

@ObjectType()
export class ConversionEventEdge {
  @Field()
  cursor!: string;

  @Field(() => ConversionEvent)
  node!: ConversionEvent;
}

@ObjectType()
export class ConversionEventConnection {
  @Field(() => [ConversionEventEdge])
  edges!: ConversionEventEdge[];

  @Field(() => [ConversionEvent])
  nodes!: ConversionEvent[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ConversionEventsArgs {
  @Field(() => Int, { nullable: true, description: '1 to 250; default 50.' })
  first?: number | null;

  @Field(() => String, { nullable: true })
  after?: string | null;

  @Field(() => ConversionStatus, { nullable: true, description: 'Those of this status alone.' })
  status?: ConversionStatus | null;

  @Field(() => ConversionPlatform, {
    nullable: true,
    description: 'Those of this platform alone (ADR-541).',
  })
  platform?: ConversionPlatform | null;

  @Field(() => ID, { nullable: true, description: "This order's alone." })
  orderId?: string | null;
}

export enum MarketingMoment {
  RAMADAN = 'ramadan',
  EID_UL_FITR = 'eid_ul_fitr',
  EID_UL_ADHA = 'eid_ul_adha',
  PAKISTAN_DAY = 'pakistan_day',
  MOTHERS_DAY = 'mothers_day',
  INDEPENDENCE_DAY = 'independence_day',
  ELEVEN_ELEVEN = 'eleven_eleven',
  WHITE_FRIDAY = 'white_friday',
  TWELVE_TWELVE = 'twelve_twelve',
  SUMMER_LAWN = 'summer_lawn',
  WINTER_COLLECTION = 'winter_collection',
  WEDDING_SEASON = 'wedding_season',
}

registerEnumType(MarketingMoment, {
  name: 'MarketingMoment',
  description: 'A moment Pakistani shoppers buy for (MKT-16).',
  valuesMap: {
    RAMADAN: { description: 'The month of Ramadan.' },
    EID_UL_FITR: { description: 'Eid ul Fitr, its three days; Chand Raat is the night before.' },
    EID_UL_ADHA: { description: 'Eid ul Adha, its three days.' },
    PAKISTAN_DAY: { description: 'Pakistan Day, 23 March.' },
    MOTHERS_DAY: { description: "Mother's Day, the second Sunday of May." },
    INDEPENDENCE_DAY: { description: 'Independence Day, 14 August.' },
    ELEVEN_ELEVEN: { description: 'The 11.11 sale, 11 November.' },
    WHITE_FRIDAY: {
      description: 'White Friday, the last Friday of November, to the Monday after.',
    },
    TWELVE_TWELVE: { description: 'The 12.12 sale, 12 December.' },
    SUMMER_LAWN: { description: "Lawn's season: new summer collections, mid-February to April." },
    WINTER_COLLECTION: { description: 'Winter collections, October and November.' },
    WEDDING_SEASON: { description: 'The wedding season, November to February.' },
  },
});

@ObjectType({ description: "A moment's ready-made campaign (ADR-484)." })
export class MarketingKit {
  @Field({ description: "A discount code to make, its year's last two digits after it: EID26." })
  code!: string;

  @Field(() => Int, { description: 'The percentage off to suggest.' })
  percentage!: number;

  @Field({
    description: "A broadcast's words in English, naming the code: short enough for one SMS.",
  })
  messageEnglish!: string;

  @Field({ description: "A broadcast's words in Urdu, naming the code." })
  messageUrdu!: string;
}

@ObjectType({ description: "A moment's dates in a year, with its kit (MKT-16, ADR-484)." })
export class MarketingDate {
  @Field(() => MarketingMoment)
  moment!: MarketingMoment;

  @Field({ description: "Its first day, YYYY-MM-DD in the shop's time zone." })
  startsOn!: string;

  @Field({ description: 'Its last day, YYYY-MM-DD: the first for a day of its own.' })
  endsOn!: string;

  @Field({ description: 'When to begin promoting for it, YYYY-MM-DD: what its code starts on.' })
  promoteFrom!: string;

  @Field({
    description:
      "Whether its dates wait on the moon's sighting: Islamic moments are expected a day after " +
      "the Umm al-Qura calendar's, as Pakistan's sighting usually is.",
  })
  expected!: boolean;

  @Field(() => MarketingKit)
  kit!: MarketingKit;
}

@ObjectType({
  description:
    "The shop's Google Analytics web stream, which its orders placed through checkout go to " +
    'through the Measurement Protocol as they are placed, confirmed and delivered, for Google ' +
    'Ads to import its purchase as a conversion (MKT-10, ADR-547).',
})
export class GoogleAnalytics {
  @Field({ description: "The web stream's measurement ID, as Google Analytics shows it." })
  measurementId!: string;

  @Field({ description: 'The last four characters of its API secret, never shown again.' })
  apiSecretHint!: string;

  @Field(() => ConversionMoment, {
    description:
      "Which moment of an order is Google's purchase; the others go as order_placed, " +
      'order_confirmed and order_delivered. DELIVERED counts only the sales that turned out.',
  })
  purchaseAt!: ConversionMoment;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class GoogleAnalyticsInput {
  @Field(() => String, {
    nullable: true,
    description: 'The web stream\'s measurement ID, "G-…": needed to connect.',
  })
  measurementId?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "A Measurement Protocol API secret the web stream's settings made: needed to connect, " +
      'kept sealed, and never shown again.',
  })
  apiSecret?: string | null;

  @Field(() => ConversionMoment, { nullable: true, description: 'PLACED unless set.' })
  purchaseAt?: ConversionMoment | null;
}

@ObjectType()
export class GoogleAnalyticsUpdatePayload {
  @Field(() => GoogleAnalytics, { nullable: true })
  googleAnalytics!: GoogleAnalytics | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class GoogleAnalyticsDeletePayload {
  @Field(() => String, {
    nullable: true,
    description: 'The measurement ID that was connected; null when none was.',
  })
  deletedMeasurementId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

export enum AdSpendPlatform {
  META = 'META',
  TIKTOK = 'TIKTOK',
  GOOGLE = 'GOOGLE',
  OTHER = 'OTHER',
}

registerEnumType(AdSpendPlatform, {
  name: 'AdSpendPlatform',
  description: "Where a shop's ads ran (ADR-553).",
  valuesMap: {
    META: { description: "Meta's apps: Facebook, Instagram, Messenger and WhatsApp." },
    TIKTOK: { description: 'TikTok.' },
    GOOGLE: { description: 'Google: search, Shopping and YouTube.' },
    OTHER: { description: 'Anywhere else: influencers, Snapchat, a newspaper.' },
  },
});

export enum AdSpendSource {
  MANUAL = 'MANUAL',
  META = 'META',
  TIKTOK = 'TIKTOK',
}

registerEnumType(AdSpendSource, {
  name: 'AdSpendSource',
  description: "Where a day's ad spend came from (ADR-564, ADR-566).",
  valuesMap: {
    MANUAL: { description: 'The shop typed it.' },
    META: {
      description:
        "Pulled from Meta's Marketing API, from the ad account the shop connected: typing over " +
        'it makes it MANUAL.',
    },
    TIKTOK: {
      description:
        "Pulled from TikTok's Business API, from the advertiser account the shop connected: " +
        'typing over it makes it MANUAL.',
    },
  },
});

@ObjectType({
  description:
    "What a shop spent on one platform's ads on a day, or on one campaign of them (ADR-553).",
})
export class AdSpendEntry {
  @Field(() => AdSpendPlatform)
  platform!: AdSpendPlatform;

  @Field({ description: "The day in the shop's time zone, as 2026-10-17." })
  day!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "The campaign, as its links' utm_campaign names it; null for the platform's day as a whole.",
  })
  campaign!: string | null;

  @Field(() => Money)
  amount!: Money;

  @Field(() => AdSpendSource)
  source!: AdSpendSource;
}

@InputType({ description: "One day's ad spend: an amount of 0 takes it away." })
export class AdSpendInput {
  @Field(() => AdSpendPlatform)
  platform!: AdSpendPlatform;

  @Field({ description: "The day in the shop's time zone, as 2026-10-17: up to today." })
  day!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "The campaign, as its links' utm_campaign names it, up to 200 characters, for the sales " +
      "report's rows by campaign; blank for the platform's day as a whole.",
  })
  campaign?: string | null;

  @Field({ description: "In the shop's currency, as 2499.50." })
  amount!: string;
}

@ObjectType()
export class AdSpendSetPayload {
  @Field(() => Int, { nullable: true, description: 'How many were recorded; null when refused.' })
  count!: number | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "The shop's Meta ad account, whose spend the worker pulls from Meta's Marketing API every few " +
    'hours, by day and campaign, for the sales report (MKT-12, ADR-564).',
})
export class MetaAdAccount {
  @Field({ description: 'Its ID, as Ads Manager shows it without "act_".' })
  adAccountId!: string;

  @Field({ description: 'Its name at Meta when it was connected.' })
  name!: string;

  @Field({ description: "What it bills in: the shop's currency." })
  currency!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "The time zone Meta reports its days in, as Asia/Karachi: each is kept as the shop's day " +
      'of that date.',
  })
  timezone!: string | null;

  @Field({ description: 'The last four characters of its access token, never shown again.' })
  accessTokenHint!: string;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When its spend was last pulled; null before the first time.',
  })
  lastSyncedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Why the last pull failed, as Meta said: the worker tries again next time. Null when it ' +
      'went through.',
  })
  lastError!: string | null;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class MetaAdAccountConnectInput {
  @Field({ description: 'Its ID, from Ads Manager: "act_123456789" or its digits.' })
  adAccountId!: string;

  @Field({
    description:
      "An access token with ads_read on the ad account, as a system user's in Business " +
      'Settings: kept sealed, and never shown again.',
  })
  accessToken!: string;
}

@ObjectType()
export class MetaAdAccountConnectPayload {
  @Field(() => MetaAdAccount, { nullable: true })
  metaAdAccount!: MetaAdAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MetaAdAccountDisconnectPayload {
  @Field(() => String, {
    nullable: true,
    description: "The ad account's ID that was connected; null when none was.",
  })
  deletedAdAccountId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class MetaAdSpendSyncPayload {
  @Field(() => MetaAdAccount, {
    nullable: true,
    description: 'The ad account after the pull: lastError says if it failed.',
  })
  metaAdAccount!: MetaAdAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({
  description:
    "The shop's TikTok advertiser account, whose spend the worker pulls from TikTok's Business " +
    'API every few hours, by day and campaign, for the sales report (MKT-12, ADR-566).',
})
export class TikTokAdAccount {
  @Field({ description: 'Its ID, as TikTok Ads Manager shows it.' })
  advertiserId!: string;

  @Field({ description: 'Its name at TikTok when it was connected.' })
  name!: string;

  @Field({ description: "What it bills in: the shop's currency." })
  currency!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "The time zone TikTok reports its days in, as Asia/Karachi: each is kept as the shop's day " +
      'of that date.',
  })
  timezone!: string | null;

  @Field({ description: 'The last four characters of its access token, never shown again.' })
  accessTokenHint!: string;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When its spend was last pulled; null before the first time.',
  })
  lastSyncedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Why the last pull failed, as TikTok said: the worker tries again next time. Null when it ' +
      'went through.',
  })
  lastError!: string | null;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class TikTokAdAccountConnectInput {
  @Field({ description: 'Its ID, from TikTok Ads Manager: its digits.' })
  advertiserId!: string;

  @Field({
    description:
      "A long-term access token of the advertiser, from TikTok's Marketing API: kept sealed, " +
      'and never shown again.',
  })
  accessToken!: string;
}

@ObjectType()
export class TikTokAdAccountConnectPayload {
  @Field(() => TikTokAdAccount, { nullable: true })
  tiktokAdAccount!: TikTokAdAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class TikTokAdAccountDisconnectPayload {
  @Field(() => String, {
    nullable: true,
    description: "The advertiser account's ID that was connected; null when none was.",
  })
  deletedAdvertiserId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class TikTokAdSpendSyncPayload {
  @Field(() => TikTokAdAccount, {
    nullable: true,
    description: 'The advertiser account after the pull: lastError says if it failed.',
  })
  tiktokAdAccount!: TikTokAdAccount | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
