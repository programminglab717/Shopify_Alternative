import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  SMS_SENDER_LIMITS,
  SmsSendersService,
  type SmsSenderRecord,
} from '../sms-senders.service.js';

export enum SmsSenderStatus {
  WAITING = 'WAITING',
  APPROVED = 'APPROVED',
  REFUSED = 'REFUSED',
  WITHDRAWN = 'WITHDRAWN',
  REPLACED = 'REPLACED',
  REVOKED = 'REVOKED',
}

registerEnumType(SmsSenderStatus, {
  name: 'SmsSenderStatus',
  description:
    "WAITING for Hatti's people, APPROVED and in use, REFUSED with why, WITHDRAWN by the shop, " +
    'REPLACED by a name approved after it, or REVOKED: taken back, with why.',
});

@ObjectType({ description: 'A request for the shop’s SMS to go from a name of its own.' })
export class SmsSenderRequest {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The name asked for, as phones would show it: "ZARI".' })
  name!: string;

  @Field(() => SmsSenderStatus)
  status!: SmsSenderStatus;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  decidedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'Why Hatti refused it or took it back, or a note on its approval.',
  })
  answer!: string | null;
}

@ObjectType({ description: "The name the shop's SMS go from (MKT-02, ADR-469)." })
export class SmsSender {
  @Field(() => String, {
    nullable: true,
    description:
      "The name approved, which its customers' SMS go from; null while they go from Hatti's " +
      'shared sender. What Hatti tells the shop itself goes from Hatti’s, whatever it is.',
  })
  name!: string | null;

  @Field(() => [SmsSenderRequest], {
    description: `Its latest ${SMS_SENDER_LIMITS.listed} requests, the newest first.`,
  })
  requests!: SmsSenderRequest[];
}

@ObjectType()
export class SmsSenderRequestPayload {
  @Field(() => SmsSenderRequest, { nullable: true })
  request!: SmsSenderRequest | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class SmsSenderWithdrawPayload {
  @Field(() => SmsSenderRequest, {
    nullable: true,
    description: 'The request withdrawn; null where none waited.',
  })
  request!: SmsSenderRequest | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** The shop's own SMS sender name (MKT-02, ADR-469). */
@Resolver(() => SmsSender)
export class SmsSenderResolver {
  constructor(private readonly service: SmsSendersService) {}

  @Query(() => SmsSender, {
    description: "The name the shop's SMS go from, and its requests for one of its own.",
  })
  @RequireScopes('read_settings')
  async smsSender(@CurrentTenant() tenant: TenantContext): Promise<SmsSender> {
    const status = await this.service.status(tenant);
    return Object.assign(new SmsSender(), {
      name: status.name,
      requests: status.requests.map(toRequest),
    });
  }

  @Mutation(() => SmsSenderRequestPayload, {
    description:
      `Asks Hatti for the shop's SMS to its customers to go from a name of its own: ` +
      `${SMS_SENDER_LIMITS.min} to ${SMS_SENDER_LIMITS.max} letters, digits and spaces, like ` +
      'ZARI, in place of any it has. Operators register it, in about two weeks, for a shop Hatti ' +
      'has verified; Hatti tells the shop when it is approved or why not. One request waits at ' +
      'a time.',
  })
  @RequireScopes('write_settings')
  async smsSenderRequest(
    @CurrentTenant() tenant: TenantContext,
    @Args('name') name: string,
  ): Promise<SmsSenderRequestPayload> {
    const result = await this.service.request(
      tenant,
      { name },
      // A member of staff by their user ID, or an app by its token's; support never writes.
      tenant.actor.kind === 'staff'
        ? tenant.actor.userId
        : tenant.actor.kind === 'app'
          ? tenant.actor.tokenId
          : '',
    );
    return Object.assign(new SmsSenderRequestPayload(), {
      request: result.ok ? toRequest(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SmsSenderWithdrawPayload, {
    description: "Withdraws the shop's request waiting for Hatti, if one does.",
  })
  @RequireScopes('write_settings')
  async smsSenderWithdraw(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<SmsSenderWithdrawPayload> {
    const withdrawn = await this.service.withdraw(tenant);
    return Object.assign(new SmsSenderWithdrawPayload(), {
      request: withdrawn && toRequest(withdrawn),
      userErrors: [],
    });
  }
}

function toRequest(record: SmsSenderRecord): SmsSenderRequest {
  return Object.assign(new SmsSenderRequest(), {
    id: toPublicId('smsSender', record.id),
    name: record.name,
    status: record.status.toUpperCase() as SmsSenderStatus,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
    answer: record.answer,
  });
}
