import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  deniedToRole,
  hasCapability,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import {
  Args,
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { ReplyTimesService, type ReplyTimesFigures } from '../reply-times.service.js';

export enum InboxReplierKind {
  STAFF = 'STAFF',
  APP = 'APP',
}

registerEnumType(InboxReplierKind, {
  name: 'InboxReplierKind',
  description: 'Who answered: a staff member, or an app by its access token.',
});

@ObjectType({ description: 'How long customers waited for the answers of one who answered.' })
export class InboxReplier {
  @Field(() => InboxReplierKind)
  kind!: InboxReplierKind;

  @Field(() => ID, { description: 'The staff member (usr_…) or the access token (tok_…).' })
  id!: string;

  @Field(() => Int, { description: 'Their answers to customers who waited.' })
  answered!: number;

  @Field(() => Int, {
    nullable: true,
    description: 'The middle of those customers’ waits, in seconds.',
  })
  medianWaitSeconds!: number | null;

  @Field(() => Int, {
    nullable: true,
    description: "Of their answers, those within the shop's reply target; null while it sets none.",
  })
  withinTarget!: number | null;
}

@ObjectType({
  description:
    "The inbox's reply times over a period (MSG-06, ADR-763): of the answers to customers who " +
    'waited on WhatsApp, how many, the middle of their waits, and how many came within the ' +
    "shop's reply target; for the shop, and for each who answered.",
})
export class InboxReplyTimes {
  @Field(() => Int)
  answered!: number;

  @Field(() => Int, { nullable: true, description: 'Null without answers.' })
  medianWaitSeconds!: number | null;

  @Field(() => Int, { nullable: true, description: 'Null while the shop sets no reply target.' })
  withinTarget!: number | null;

  @Field(() => Int, { nullable: true })
  replyTargetMinutes!: number | null;

  @Field(() => [InboxReplier], { description: 'Those who answered most first.' })
  repliers!: InboxReplier[];
}

@ArgsType()
export class InboxReplyTimesArgs {
  @Field(() => GraphQLISODateTime, { description: 'Answers from this time.' })
  from!: Date;

  @Field(() => GraphQLISODateTime, {
    description: 'Answers before this time; at most a year after `from`.',
  })
  before!: Date;
}

const figures = (row: ReplyTimesFigures) => ({
  answered: row.answered,
  medianWaitSeconds: row.medianWaitSeconds,
  withinTarget: row.withinTarget,
});

@Resolver()
export class ReplyTimesResolver {
  constructor(private readonly times: ReplyTimesService) {}

  @Query(() => InboxReplyTimes, {
    description:
      "The inbox's reply times (MSG-06, ADR-763), worked out when asked. Owners and managers " +
      'see them, and custom roles that see staff performance, and apps with read_conversations.',
  })
  @RequireScopes('read_conversations')
  async inboxReplyTimes(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: InboxReplyTimesArgs,
  ): Promise<InboxReplyTimes> {
    // Who answered how fast is staff performance, as agents' performance is (ADR-578).
    if (tenant.actor.kind === 'staff' && !hasCapability(tenant.actor, 'see_staff_performance')) {
      throw deniedToRole('Access denied. Only owners and managers see the reply times.');
    }
    const result = await this.times.report(tenant, { from: args.from, before: args.before });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    const report = result.value;
    return Object.assign(new InboxReplyTimes(), {
      ...figures(report),
      replyTargetMinutes: report.replyTargetMinutes,
      repliers: report.byActor.map((row) =>
        Object.assign(new InboxReplier(), {
          kind: row.actor.kind === 'app' ? InboxReplierKind.APP : InboxReplierKind.STAFF,
          id: toPublicId(row.actor.kind === 'app' ? 'accessToken' : 'user', row.actor.id),
          ...figures(row),
        }),
      ),
    });
  }
}
