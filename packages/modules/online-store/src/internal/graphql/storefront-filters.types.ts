import { UserError } from '@hatti/api';
import { Field, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum StorefrontFilterKind {
  AVAILABILITY = 'AVAILABILITY',
  PRICE = 'PRICE',
  PRODUCT_TYPE = 'PRODUCT_TYPE',
  VENDOR = 'VENDOR',
  OPTION = 'OPTION',
  STITCHING = 'STITCHING',
  PIECES = 'PIECES',
  FABRIC = 'FABRIC',
  SEASON = 'SEASON',
  PRODUCT_METAFIELD = 'PRODUCT_METAFIELD',
  VARIANT_METAFIELD = 'VARIANT_METAFIELD',
}

registerEnumType(StorefrontFilterKind, {
  name: 'StorefrontFilterKind',
  description:
    "What one of the storefront's filters narrows a collection's or a search's products by.",
  valuesMap: {
    AVAILABILITY: { description: 'Whether a variant is in stock: filter.v.availability.' },
    PRICE: { description: "A variant's price, from and to: filter.v.price.gte and .lte." },
    PRODUCT_TYPE: { description: 'filter.p.product_type.' },
    VENDOR: { description: 'The brand: filter.p.vendor.' },
    OPTION: {
      description: 'One of the options, named by key, as Size: filter.v.option.size.',
    },
    STITCHING: { description: 'Stitched or unstitched: filter.p.m.hatti.stitching.' },
    PIECES: { description: 'How many pieces a suit has: filter.p.m.hatti.pieces.' },
    FABRIC: { description: 'filter.p.m.hatti.fabric.' },
    SEASON: { description: 'filter.p.m.hatti.season.' },
    PRODUCT_METAFIELD: {
      description:
        "A product metafield, named by key as its definition's namespace.key, as " +
        'custom.material: filter.p.m.custom.material.',
    },
    VARIANT_METAFIELD: {
      description: 'A variant metafield, likewise: filter.v.m.custom.material.',
    },
  },
});

@ObjectType({
  description:
    "One of the storefront's filters (ADR-568): one the shop chose, or one it could choose.",
})
export class StorefrontFilter {
  @Field(() => StorefrontFilterKind)
  kind!: StorefrontFilterKind;

  @Field(() => String, {
    nullable: true,
    description:
      "The option's name, as Size, for an option's filter; the metafield definition's " +
      "namespace.key, as custom.material, for a metafield's; null for the others.",
  })
  key!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'What English pages call it, as the shop wrote it; null for defaultLabel.',
  })
  label!: string | null;

  @Field(() => String, {
    nullable: true,
    description: "What Urdu pages call it; null for label, or the platform's Urdu words.",
  })
  labelUr!: string | null;

  @Field({
    description:
      "What its pages call it without a label: the platform's words, the option's name as " +
      "the shop's products spell it, or the metafield definition's name.",
  })
  defaultLabel!: string;

  @Field(() => String, {
    nullable: true,
    description:
      "A metafield's type, as its definition fixes it: single_line_text_field, " +
      'list.single_line_text_field or boolean; null for the others, or a definition deleted since.',
  })
  metafieldType!: string | null;
}

@ObjectType({
  description:
    "The filters the storefront's collection and search pages show (SRC-03, ADR-568), as " +
    "Shopify's Search & Discovery app chooses them, and those the shop could choose.",
})
export class OnlineStoreFilters {
  @Field(() => [StorefrontFilter], {
    nullable: true,
    description:
      'Those its pages show, in their order; null while the shop chose none, when its pages ' +
      'show availability, price, product type, brand, each option, stitching, pieces, fabric ' +
      'and season, in that order.',
  })
  filters!: StorefrontFilter[] | null;

  @Field(() => [StorefrontFilter], {
    description:
      "Those the shop could choose: the platform's, one for each of its products' options, " +
      'the most used first, and one for each of its product and variant metafield definitions ' +
      'of single line text, lists of it, or true or false.',
  })
  availableFilters!: StorefrontFilter[];
}

@InputType({ description: 'One of the filters the storefront shows.' })
export class StorefrontFilterInput {
  @Field(() => StorefrontFilterKind)
  kind!: StorefrontFilterKind;

  @Field(() => String, {
    nullable: true,
    description:
      "For an option's filter, the option's name, matched whatever its case: one none of the " +
      "products has yet shows nothing until one does. For a metafield's, one of the shop's " +
      "definitions' namespace.key. None for the others.",
  })
  key?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'What English pages call it, up to 60 characters; blank for defaultLabel.',
  })
  label?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'What Urdu pages call it, up to 60 characters; blank for label.',
  })
  labelUr?: string | null;
}

@InputType()
export class OnlineStoreFiltersInput {
  @Field(() => [StorefrontFilterInput], {
    nullable: true,
    description:
      'The filters, in the order the pages show them, up to 25, each once; an empty list for ' +
      "none. Null for the platform's, in its order, as for a shop that never chose.",
  })
  filters!: StorefrontFilterInput[] | null;
}

@ObjectType()
export class OnlineStoreFiltersUpdatePayload {
  @Field(() => OnlineStoreFilters, { nullable: true })
  onlineStoreFilters!: OnlineStoreFilters | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
