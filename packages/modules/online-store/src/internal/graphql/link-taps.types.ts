import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { SESSION_REPORT_LIMITS } from '../session-days.service.js';

/** Where a tapped link stands on the link page now, with the value the module keeps. */
export enum LinkTapSource {
  LINK = 'link',
  WHATSAPP = 'whatsapp',
  REMOVED = 'removed',
}

registerEnumType(LinkTapSource, {
  name: 'LinkTapSource',
  description: 'Where a tapped link of the link page stands on it now.',
  valuesMap: {
    LINK: { description: "One of the shop's own links on the page." },
    WHATSAPP: {
      description: "The shop's chat on WhatsApp, which the page links when the shop has a number.",
    },
    REMOVED: { description: 'A link since taken off the page, or changed to go elsewhere.' },
  },
});

@ObjectType({ description: "One of the link page's links, and its taps over a period." })
export class LinkTaps {
  @Field({ description: 'Where it goes: a path on the storefront, or an https address.' })
  url!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'Its title on the page now; null for the chat on WhatsApp and a link since taken off.',
  })
  title!: string | null;

  @Field(() => LinkTapSource)
  source!: LinkTapSource;

  @Field(() => Int)
  taps!: number;
}

@ObjectType({
  description: "Taps on the links of the shop's link page over a period (CH-07, ADR-204).",
})
export class LinkPageTapsReport {
  @Field(() => Int, { description: 'Every tap of the period.' })
  total!: number;

  @Field(() => [LinkTaps], {
    description:
      "The page's links now and its chat on WhatsApp, those not tapped too, and the links since " +
      "taken off that were tapped: the most tapped first, then in the page's order.",
  })
  links!: LinkTaps[];
}

@ArgsType()
export class LinkPageTapsArgs {
  @Field(() => GraphQLISODateTime, {
    description: "Taps from the day this falls on, in the shop's time zone.",
  })
  from!: Date;

  @Field(() => GraphQLISODateTime, {
    description:
      `Taps to the day before this falls on; at most ${SESSION_REPORT_LIMITS.days} days after ` +
      'from. Taps are counted by the day: the first and last days count whole.',
  })
  before!: Date;
}
