import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import {
  EXPERIMENT_LIMITS,
  ThemeExperimentService,
  verdictOf,
  type ArmCounts,
  type ThemeExperimentRecord,
} from '../theme-experiments.js';

@ObjectType({
  description: 'An arm of a theme experiment: its sessions and their steps (ADR-180).',
})
export class ThemeExperimentArm {
  @Field(() => Int)
  sessions!: number;

  @Field(() => Int)
  addedToCart!: number;

  @Field(() => Int)
  reachedCheckout!: number;

  @Field(() => Int)
  converted!: number;

  @Field(() => Float, { description: 'The share of its sessions that ordered, from 0 to 1.' })
  conversionRate!: number;
}

@ObjectType({
  description:
    'A theme experiment (OS-22, ADR-866): a draft of the shop’s theme shown a share of its ' +
    'shoppers, the rest shown the live one, each keeping the theme first shown them.',
})
export class ThemeExperiment {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => ID, { description: 'The draft theme shown in the second arm.' })
  themeId!: string;

  @Field(() => Int, { description: 'The percent of shoppers shown the draft.' })
  share!: number;

  @Field(() => GraphQLISODateTime)
  startedAt!: Date;

  @Field(() => GraphQLISODateTime, { description: 'When it ends by itself.' })
  endsAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  endedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Why it ended: staff, time, guardrail (its draft sold clearly worse) or theme_changed ' +
      '(a theme was published, or its draft deleted).',
  })
  endedReason!: string | null;

  @Field(() => ThemeExperimentArm, { description: 'The live theme’s arm.' })
  live!: ThemeExperimentArm;

  @Field(() => ThemeExperimentArm, { description: 'The draft’s arm.' })
  draft!: ThemeExperimentArm;

  @Field({
    description:
      `too_early, until each arm has ${EXPERIMENT_LIMITS.sessions} sessions; then b_better or ` +
      'b_worse where the draft’s share of sessions that ordered differs, at 95% confidence, and ' +
      'no_difference where it doesn’t.',
  })
  verdict!: string;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When its counts were taken.' })
  countedAt!: Date | null;
}

@InputType()
export class ThemeExperimentInput {
  @Field()
  name!: string;

  @Field(() => ID)
  themeId!: string;

  @Field(() => Int, { description: 'The percent of shoppers shown the draft, 1 to 50.' })
  share!: number;

  @Field(() => Int, { description: 'How many days it runs, 1 to 30.' })
  days!: number;
}

@ObjectType()
export class ThemeExperimentPayload {
  @Field(() => ThemeExperiment, { nullable: true })
  themeExperiment!: ThemeExperiment | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toArm = (counts: ArmCounts) =>
  Object.assign(new ThemeExperimentArm(), {
    sessions: counts.sessions,
    addedToCart: counts.added_to_cart,
    reachedCheckout: counts.reached_checkout,
    converted: counts.converted,
    conversionRate: counts.sessions === 0 ? 0 : counts.converted / counts.sessions,
  });

const toExperiment = (record: ThemeExperimentRecord) =>
  Object.assign(new ThemeExperiment(), {
    id: toPublicId('themeExperiment', record.id),
    name: record.name,
    themeId: toPublicId('theme', record.themeId),
    share: record.share,
    startedAt: record.startedAt,
    endsAt: record.endsAt,
    endedAt: record.endedAt,
    endedReason: record.endedReason,
    live: toArm(record.results.a),
    draft: toArm(record.results.b),
    verdict: verdictOf(record.results),
    countedAt: record.countedAt,
  });

const payload = (result: Awaited<ReturnType<ThemeExperimentService['start']>>) =>
  Object.assign(new ThemeExperimentPayload(), {
    themeExperiment: result.ok ? toExperiment(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });

const notFound = (field: string) =>
  Object.assign(new ThemeExperimentPayload(), {
    themeExperiment: null,
    userErrors: UserError.list([
      { field: ['input', field], code: 'NOT_FOUND', message: 'Not found' },
    ]),
  });

/** The shop's theme experiments (ADR-866), run by those who change its themes. */
@Resolver(() => ThemeExperiment)
export class ThemeExperimentResolver {
  constructor(private readonly experiments: ThemeExperimentService) {}

  @Query(() => [ThemeExperiment], {
    description:
      "The shop's theme experiments, the newest first: the running one, and those before.",
  })
  @RequireScopes('read_themes')
  async themeExperiments(@CurrentTenant() tenant: TenantContext): Promise<ThemeExperiment[]> {
    return (await this.experiments.list(tenant)).map(toExperiment);
  }

  @Mutation(() => ThemeExperimentPayload, {
    description:
      'Starts showing a draft theme to a share of shoppers, the rest the live theme, for up to 30 ' +
      'days: one experiment at a time.',
  })
  @RequireScopes('write_themes')
  async themeExperimentStart(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ThemeExperimentInput,
  ): Promise<ThemeExperimentPayload> {
    const themeId = tryFromPublicId(input.themeId, 'theme');
    if (!themeId) return notFound('themeId');
    return payload(
      await this.experiments.start(tenant, {
        name: input.name,
        themeId,
        share: input.share,
        days: input.days,
      }),
    );
  }

  @Mutation(() => ThemeExperimentPayload, {
    description: 'Ends a running experiment: every shopper sees the live theme again.',
  })
  @RequireScopes('write_themes')
  async themeExperimentEnd(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ThemeExperimentPayload> {
    const uuid = tryFromPublicId(id, 'themeExperiment');
    if (!uuid) return notFound('id');
    return payload(await this.experiments.end(tenant, uuid));
  }
}
