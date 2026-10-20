import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { StaffService } from '@hatti/identity/public';
import { DESK_DUTY, DeskDutyService, type DeskDutyRecord } from '@hatti/orders/public';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';

@ObjectType({
  description:
    'A member of staff on duty at the Confirmation Desk (ADR-654): until when, and how many of ' +
    'the orders given to them wait to be confirmed.',
})
export class DeskDuty {
  @Field(() => ID, { description: 'Their account: usr_…' })
  staffMemberId!: string;

  @Field()
  name!: string;

  @Field(() => GraphQLISODateTime)
  startedAt!: Date;

  @Field(() => GraphQLISODateTime)
  endsAt!: Date;

  @Field(() => Int)
  waiting!: number;

  @Field({ description: 'Whether it is the caller.' })
  isYou!: boolean;
}

@ObjectType()
export class DeskDutyStartPayload {
  @Field(() => DeskDuty, { nullable: true })
  duty!: DeskDuty | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class DeskDutyEndPayload {
  @Field(() => Int, { description: 'How many of your orders went to others on duty.' })
  handedOver!: number;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Agents on duty at the Confirmation Desk (ADR-654). The orders module keeps the shifts and shares
 * new orders among them; the core says who the caller is by name, from the shop's staff.
 */
@Resolver()
export class DeskDutyResolver {
  constructor(
    private readonly duty: DeskDutyService,
    private readonly staff: StaffService,
  ) {}

  @Query(() => [DeskDuty], {
    description:
      'Who is on duty at the Confirmation Desk now, the soonest to end first. Where the shop ' +
      'shares new orders out (orderSettings.shareNewOrders), each order placed that needs a call ' +
      'is given to one of them (ADR-654).',
  })
  @RequireScopes('read_orders')
  async confirmationDeskDuty(@CurrentTenant() tenant: TenantContext): Promise<DeskDuty[]> {
    return (await this.duty.onDuty(tenant)).map((record) => toDuty(record, tenant));
  }

  @Mutation(() => DeskDutyStartPayload, {
    description:
      `Puts you on duty at the Confirmation Desk for ${DESK_DUTY.hours.min} to ` +
      `${DESK_DUTY.hours.max} hours, ${DESK_DUTY.defaultHours} unless you say; on duty already, ` +
      'it moves when your shift ends. For members of staff: no order is given to an app.',
  })
  @RequireScopes('write_orders')
  async confirmationDeskDutyStart(
    @CurrentTenant() tenant: TenantContext,
    @Args('hours', { type: () => Int, nullable: true }) hours?: number | null,
  ): Promise<DeskDutyStartPayload> {
    const name =
      tenant.actor.kind === 'staff'
        ? (await this.staff.staffOf(tenant.shopId)).find(
            (member) => member.userId === (tenant.actor as { userId: string }).userId,
          )?.name
        : undefined;
    const result = await this.duty.start(tenant, name ?? '', hours ?? DESK_DUTY.defaultHours);
    return Object.assign(new DeskDutyStartPayload(), {
      duty: result.ok ? toDuty(result.value, tenant) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => DeskDutyEndPayload, {
    description:
      'Takes you off duty at the desk. The orders given to you stay yours, unless you hand over ' +
      'those still waiting to be confirmed: each goes to whoever else is on duty with the fewest ' +
      'waiting (ADR-656).',
  })
  @RequireScopes('write_orders')
  async confirmationDeskDutyEnd(
    @CurrentTenant() tenant: TenantContext,
    @Args('handOver', { nullable: true, defaultValue: false }) handOver: boolean,
  ): Promise<DeskDutyEndPayload> {
    const handedOver = await this.duty.end(tenant, { handOver });
    return Object.assign(new DeskDutyEndPayload(), { handedOver, userErrors: [] });
  }
}

function toDuty(record: DeskDutyRecord, tenant: TenantContext): DeskDuty {
  return Object.assign(new DeskDuty(), {
    staffMemberId: toPublicId('user', record.staffMemberId),
    name: record.name,
    startedAt: record.startedAt,
    endsAt: record.endsAt,
    waiting: record.waiting,
    isYou: tenant.actor.kind === 'staff' && tenant.actor.userId === record.staffMemberId,
  });
}
