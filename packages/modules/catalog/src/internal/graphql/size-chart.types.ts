import { UserError } from '@hatti/api';
import {
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum SizeChartUnit {
  INCHES = 'INCHES',
  CENTIMETERS = 'CENTIMETERS',
}

registerEnumType(SizeChartUnit, {
  name: 'SizeChartUnit',
  description: "The unit a chart's measurements are written in; shoppers may read them in either.",
});

@ObjectType({ description: "A size and its measurements, in the order of its chart's columns." })
export class SizeChartRow {
  @Field({ description: '"S", "38", "Free size".' })
  size!: string;

  @Field(() => [Float], {
    nullable: 'items',
    description: "One for each of the chart's columns; null where none is given.",
  })
  values!: (number | null)[];
}

@ObjectType({
  description:
    'A table of measurements, a row for each size (CAT-10, ADR-406), which the products it is ' +
    'given to show on their pages.',
})
export class SizeChart {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The shop\'s own name for it, unique in the shop: "Women\'s kurtas".' })
  name!: string;

  @Field(() => SizeChartUnit)
  unit!: SizeChartUnit;

  @Field(() => [String], { description: 'What is measured, in order: "Chest", "Length".' })
  columns!: string[];

  @Field(() => [SizeChartRow])
  rows!: SizeChartRow[];

  @Field(() => String, { nullable: true, description: 'How to measure, or what else to know.' })
  note!: string | null;

  @Field(() => Int, { description: 'How many products show it.' })
  productsCount!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class SizeChartRowInput {
  @Field({ description: '1 to 20 characters, unique in the chart.' })
  size!: string;

  @Field(() => [Float], {
    nullable: 'items',
    description: 'One for each column, more than 0 and at most 999, or null.',
  })
  values!: (number | null)[];
}

@InputType({
  description:
    'What a chart is made of. Creating one takes its name, unit, columns and rows; an update ' +
    'leaves what it omits as it is, but takes the rows again with new columns.',
})
export class SizeChartInput {
  @Field(() => String, { nullable: true, description: '1 to 100 characters.' })
  name?: string | null;

  @Field(() => SizeChartUnit, { nullable: true })
  unit?: SizeChartUnit | null;

  @Field(() => [String], { nullable: true, description: '1 to 8, each 1 to 40 characters.' })
  columns?: string[] | null;

  @Field(() => [SizeChartRowInput], { nullable: true, description: '1 to 30 sizes.' })
  rows?: SizeChartRowInput[] | null;

  @Field(() => String, { nullable: true, description: 'Up to 1,000 characters; null for none.' })
  note?: string | null;
}

@ObjectType()
export class SizeChartPayload {
  @Field(() => SizeChart, { nullable: true })
  sizeChart!: SizeChart | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SizeChartDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedSizeChartId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductsSizeChartSetPayload {
  @Field(() => [ID], { description: 'The products whose chart changed.' })
  productIds!: string[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}
