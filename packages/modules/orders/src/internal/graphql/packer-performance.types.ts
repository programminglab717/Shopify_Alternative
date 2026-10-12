import { ArgsType, Field, Float, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import { ConfirmationAgentKind } from './agent-performance.types.js';

@ObjectType({
  description:
    'How one packer did over a period (APP-04, COD-11): the orders they marked as packed, the ' +
    'units in them, and their hours at it.',
})
export class Packer {
  @Field(() => ConfirmationAgentKind, {
    description: 'A staff member, or an app by its access token.',
  })
  kind!: ConfirmationAgentKind;

  @Field(() => ID, { description: 'The staff member (usr_…) or the access token (tok_…).' })
  id!: string;

  @Field(() => Int, {
    description:
      'Orders they marked as packed that nobody has unpacked since: packed still, or shipped.',
  })
  packed!: number;

  @Field(() => Int, { description: 'The units in those orders, as their items stand now.' })
  units!: number;

  @Field(() => Int, {
    description: "The hours of the shop's day in which they marked any order as packed.",
  })
  activeHours!: number;

  @Field(() => Float, {
    nullable: true,
    description: 'Orders packed an active hour, to two places; null without active hours.',
  })
  packedPerHour!: number | null;
}

@ArgsType()
export class PackersArgs {
  @Field(() => GraphQLISODateTime, { description: 'Packing done at or after this.' })
  from!: Date;

  @Field(() => GraphQLISODateTime, {
    description: 'Packing done before this; at most 366 days after from.',
  })
  before!: Date;

  @Field(() => Int, { nullable: true, description: 'Packers at most, 1 to 250; default 50.' })
  first?: number | null;
}
