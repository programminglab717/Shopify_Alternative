import { CurrentTenant, Money, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { money, type CurrencyCode } from '@hatti/money';
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
  draftArmsOf,
  revenueVerdictOf,
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

  @Field(() => Money, {
    description: "What its sessions' orders placed at checkout came to (ADR-921).",
  })
  revenue!: Money;

  @Field(() => Money, { description: 'Its revenue over its sessions.' })
  revenuePerSession!: Money;
}

@ObjectType({
  description:
    'A draft a theme experiment shows (ADR-931): its arm, and what the experiment says of it ' +
    'against the live theme.',
})
export class ThemeExperimentDraft {
  @Field(() => ID)
  themeId!: string;

  @Field(() => ThemeExperimentArm)
  arm!: ThemeExperimentArm;

  @Field({ description: 'As the experiment’s `verdict`, of this draft.' })
  verdict!: string;

  @Field({ description: 'As the experiment’s `revenueVerdict`, of this draft.' })
  revenueVerdict!: string;

  @Field({
    description:
      'Whether Hatti stopped this draft as it sold clearly worse, its shoppers shown the live ' +
      'theme since and its counts kept as they were, the other drafts going on (ADR-939).',
  })
  stopped!: boolean;

  @Field(() => Int, { description: 'The percent of shoppers shown it (ADR-952).' })
  share!: number;
}

@ObjectType({
  description:
    'A theme experiment (OS-22, ADR-866): up to three drafts of the shop’s theme, each shown a ' +
    'share of its shoppers (ADR-931), the rest shown the live one, each keeping the theme first ' +
    'shown them.',
})
export class ThemeExperiment {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => ID, { description: 'The draft theme shown in the second arm: the first draft.' })
  themeId!: string;

  @Field(() => Int, { description: 'The percent of shoppers shown the first draft.' })
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

  @Field(() => ThemeExperimentArm, { description: 'The first draft’s arm.' })
  draft!: ThemeExperimentArm;

  @Field(() => [ThemeExperimentDraft], {
    description: 'Each draft it shows, the first one first, and what it says of each (ADR-931).',
  })
  drafts!: ThemeExperimentDraft[];

  @Field({
    description:
      `too_early, until each arm has ${EXPERIMENT_LIMITS.sessions} sessions; then b_better or ` +
      'b_worse where the first draft’s share of sessions that ordered differs, at 95% ' +
      'confidence split among its drafts, and no_difference where it doesn’t.',
  })
  verdict!: string;

  @Field({
    description:
      'As `verdict`, of each arm’s revenue a session (ADR-921): b_better or b_worse where the ' +
      'draft brings more or less money a session, at 95% confidence.',
  })
  revenueVerdict!: string;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When its counts were taken.' })
  countedAt!: Date | null;
}

@InputType()
export class ThemeExperimentInput {
  @Field()
  name!: string;

  @Field(() => ID)
  themeId!: string;

  @Field(() => [ID], {
    nullable: true,
    description: 'Up to two drafts more, each shown its own share (ADR-931).',
  })
  otherThemeIds?: string[] | null;

  @Field(() => Int, {
    description:
      'The percent of shoppers shown the first draft, and each other one where otherShares ' +
      'gives none: 1 to 50 for one draft, to 33 for two, to 25 for three.',
  })
  share!: number;

  @Field(() => [Int], {
    nullable: true,
    description:
      'Each other draft’s own percent of shoppers, in the order of otherThemeIds (ADR-952), 1 ' +
      'to 50: the live theme is shown to no fewer than any draft.',
  })
  otherShares?: number[] | null;

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

const toArm = (counts: ArmCounts, currency: CurrencyCode) =>
  Object.assign(new ThemeExperimentArm(), {
    sessions: counts.sessions,
    addedToCart: counts.added_to_cart,
    reachedCheckout: counts.reached_checkout,
    converted: counts.converted,
    conversionRate: counts.sessions === 0 ? 0 : counts.converted / counts.sessions,
    revenue: Money.from(money(BigInt(Math.round(counts.revenue)), currency)),
    revenuePerSession: Money.from(
      money(
        BigInt(counts.sessions === 0 ? 0 : Math.round(counts.revenue / counts.sessions)),
        currency,
      ),
    ),
  });

const toExperiment = (record: ThemeExperimentRecord, currency: CurrencyCode) =>
  Object.assign(new ThemeExperiment(), {
    id: toPublicId('themeExperiment', record.id),
    name: record.name,
    themeId: toPublicId('theme', record.themeId),
    share: record.share,
    startedAt: record.startedAt,
    endsAt: record.endsAt,
    endedAt: record.endedAt,
    endedReason: record.endedReason,
    live: toArm(record.results.a, currency),
    draft: toArm(record.results.b, currency),
    drafts: draftArmsOf(record.results).map((arm, index) =>
      Object.assign(new ThemeExperimentDraft(), {
        themeId: toPublicId('theme', record.themeIds[index]!),
        arm: toArm(record.results[arm]!, currency),
        verdict: verdictOf(record.results, arm),
        revenueVerdict: revenueVerdictOf(record.results, arm),
        stopped: record.stoppedArms.includes(arm),
        share: record.shares[index]!,
      }),
    ),
    verdict: verdictOf(record.results),
    revenueVerdict: revenueVerdictOf(record.results),
    countedAt: record.countedAt,
  });

const payload = (
  result: Awaited<ReturnType<ThemeExperimentService['start']>>,
  currency: CurrencyCode,
) =>
  Object.assign(new ThemeExperimentPayload(), {
    themeExperiment: result.ok ? toExperiment(result.value, currency) : null,
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
    return (await this.experiments.list(tenant)).map((each) => toExperiment(each, tenant.currency));
  }

  @Mutation(() => ThemeExperimentPayload, {
    description:
      'Starts showing up to three draft themes, each to a share of shoppers, the rest the live ' +
      'theme, for up to 30 days: one experiment at a time.',
  })
  @RequireScopes('write_themes')
  async themeExperimentStart(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: ThemeExperimentInput,
  ): Promise<ThemeExperimentPayload> {
    const themeId = tryFromPublicId(input.themeId, 'theme');
    if (!themeId) return notFound('themeId');
    const others = (input.otherThemeIds ?? []).map((id) => tryFromPublicId(id, 'theme'));
    if (others.some((id) => id === null)) return notFound('otherThemeIds');
    return payload(
      await this.experiments.start(tenant, {
        name: input.name,
        themeId,
        otherThemeIds: others as string[],
        share: input.share,
        otherShares: input.otherShares ?? null,
        days: input.days,
      }),
      tenant.currency,
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
    return payload(await this.experiments.end(tenant, uuid), tenant.currency);
  }
}
