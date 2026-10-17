import { Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

// Eastern-wear attributes on the Admin API (CAT-08, ADR-477): Hatti's own words for each, so
// every shop's lawn is the same lawn to filter by.

export enum Stitching {
  UNSTITCHED = 'unstitched',
  SEMI_STITCHED = 'semi_stitched',
  STITCHED = 'stitched',
}
registerEnumType(Stitching, {
  name: 'Stitching',
  description: 'Whether a suit comes stitched (ADR-477).',
});

export enum Fabric {
  LAWN = 'lawn',
  CAMBRIC = 'cambric',
  COTTON = 'cotton',
  KHADDAR = 'khaddar',
  KARANDI = 'karandi',
  LINEN = 'linen',
  MARINA = 'marina',
  VISCOSE = 'viscose',
  DOBBY = 'dobby',
  JACQUARD = 'jacquard',
  CHIFFON = 'chiffon',
  GEORGETTE = 'georgette',
  ORGANZA = 'organza',
  NET = 'net',
  SILK = 'silk',
  RAW_SILK = 'raw_silk',
  VELVET = 'velvet',
  JAMAWAR = 'jamawar',
  WOOL = 'wool',
  PASHMINA = 'pashmina',
}
registerEnumType(Fabric, {
  name: 'Fabric',
  description: 'A fabric Pakistani shops sell eastern wear in (ADR-477).',
});

export enum Season {
  SUMMER = 'summer',
  WINTER = 'winter',
  FESTIVE = 'festive',
  ALL_SEASON = 'all_season',
}
registerEnumType(Season, { name: 'Season', description: 'The season it is for (ADR-477).' });

@ObjectType({
  description:
    'How shoppers choose a suit (CAT-08, ADR-477): whether it comes stitched, in how many ' +
    'pieces, of what fabrics, and for which season. Each may be unsaid.',
})
export class EasternWear {
  @Field(() => Stitching, { nullable: true })
  stitching!: Stitching | null;

  @Field(() => Int, { nullable: true, description: 'A shirt, trousers and dupatta are 3.' })
  pieces!: number | null;

  @Field(() => [Fabric], { description: 'Up to 3: a shirt of one, a dupatta of another.' })
  fabrics!: Fabric[];

  @Field(() => Season, { nullable: true })
  season!: Season | null;
}

@InputType({ description: "All of a product's eastern-wear attributes; one left out is unsaid." })
export class EasternWearInput {
  @Field(() => Stitching, { nullable: true })
  stitching?: Stitching | null;

  @Field(() => Int, { nullable: true, description: 'From 1 to 4.' })
  pieces?: number | null;

  @Field(() => [Fabric], { nullable: true, description: 'Up to 3, each once.' })
  fabrics?: Fabric[] | null;

  @Field(() => Season, { nullable: true })
  season?: Season | null;
}
