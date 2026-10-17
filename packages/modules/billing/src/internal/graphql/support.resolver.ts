import { CurrentTenant, UserError, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { SUPPORT_LIMITS, SupportService, type SupportRequestRecord } from '../support.service.js';
import { BillingPlanCode } from './billing.types.js';

export enum SupportChannel {
  HELP_CENTRE = 'HELP_CENTRE',
  WHATSAPP = 'WHATSAPP',
  PRIORITY_WHATSAPP = 'PRIORITY_WHATSAPP',
  PRIORITY_CALL = 'PRIORITY_CALL',
}

registerEnumType(SupportChannel, {
  name: 'SupportChannel',
  description:
    "How the shop reaches Hatti's people, as its plan allows: the HELP_CENTRE and requests " +
    'from the admin on Free; WHATSAPP on Starter; PRIORITY_WHATSAPP on Growth; PRIORITY_CALL, ' +
    'WhatsApp and a phone line, on Pro.',
});

export enum SupportTopic {
  ORDERS = 'ORDERS',
  PAYMENTS = 'PAYMENTS',
  COURIERS = 'COURIERS',
  STORE = 'STORE',
  BILLING = 'BILLING',
  ACCOUNT = 'ACCOUNT',
  OTHER = 'OTHER',
}

registerEnumType(SupportTopic, { name: 'SupportTopic' });

export enum SupportRequestStatus {
  OPEN = 'OPEN',
  ANSWERED = 'ANSWERED',
  CLOSED = 'CLOSED',
}

registerEnumType(SupportRequestStatus, { name: 'SupportRequestStatus' });

export enum SupportLanguage {
  ENGLISH = 'ENGLISH',
  URDU = 'URDU',
}

registerEnumType(SupportLanguage, { name: 'SupportLanguage' });

@ObjectType({ description: 'A request the shop sent Hatti’s people, and their answer.' })
export class SupportRequest {
  @Field(() => ID)
  id!: string;

  @Field(() => SupportTopic)
  topic!: SupportTopic;

  @Field()
  message!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The mobile to call back at, E.164; null for no call.',
  })
  callBack!: string | null;

  @Field(() => SupportRequestStatus)
  status!: SupportRequestStatus;

  @Field(() => String, { nullable: true })
  answer!: string | null;

  @Field(() => String, { nullable: true, description: 'Who at Hatti answered.' })
  answeredBy!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  answeredAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;
}

@ObjectType({ description: 'When Hatti’s people answer.' })
export class SupportHours {
  @Field()
  en!: string;

  @Field()
  ur!: string;
}

@ObjectType({ description: "Hatti's support for the shop (BIL-05, ADR-508), as its plan allows." })
export class HattiSupport {
  @Field(() => BillingPlanCode)
  plan!: BillingPlanCode;

  @Field(() => SupportChannel)
  channel!: SupportChannel;

  @Field(() => Int, { description: 'How soon a request is answered, in working hours.' })
  answerWithinHours!: number;

  @Field(() => String, {
    nullable: true,
    description: "Hatti's support WhatsApp, E.164, for plans that have it.",
  })
  whatsapp!: string | null;

  @Field(() => String, { nullable: true, description: "Hatti's phone line, on Pro." })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  email!: string | null;

  @Field(() => SupportHours, { nullable: true })
  hours!: SupportHours | null;

  @Field(() => [SupportRequest], {
    description: `The shop's latest ${SUPPORT_LIMITS.listed} requests, the newest first.`,
  })
  requests!: SupportRequest[];
}

@InputType()
export class SupportRequestInput {
  @Field(() => SupportTopic)
  topic!: SupportTopic;

  @Field({
    description: `What the shop needs, ${SUPPORT_LIMITS.message.min} to ${SUPPORT_LIMITS.message.max} characters.`,
  })
  message!: string;

  @Field(() => SupportLanguage, { description: 'The language it is in, which the answer is in.' })
  language!: SupportLanguage;

  @Field(() => String, {
    nullable: true,
    description: 'A Pakistani mobile for Hatti to call back at, if the shop wants a call.',
  })
  callBack?: string | null;
}

@ObjectType()
export class SupportRequestPayload {
  @Field(() => SupportRequest, { nullable: true })
  request!: SupportRequest | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Hatti's support for the shop (BIL-05, ADR-508): any member of staff sees how to reach Hatti's
 * people and asks them for help; no scope is asked, as help is for everyone at the shop.
 */
@Resolver(() => HattiSupport)
export class SupportResolver {
  constructor(private readonly service: SupportService) {}

  @Query(() => HattiSupport, {
    description: "How the shop reaches Hatti's people, as its plan allows, and its requests.",
  })
  async hattiSupport(@CurrentTenant() tenant: TenantContext): Promise<HattiSupport> {
    const [support, requests] = await Promise.all([
      this.service.support(tenant),
      this.service.requests(tenant),
    ]);
    return Object.assign(new HattiSupport(), {
      plan: support.plan.toUpperCase() as BillingPlanCode,
      channel: support.tier.channel.toUpperCase() as SupportChannel,
      answerWithinHours: support.tier.answerWithinHours,
      whatsapp: support.whatsapp,
      phone: support.phone,
      email: support.email,
      hours: support.hours && Object.assign(new SupportHours(), support.hours),
      requests: requests.map(toRequest),
    });
  }

  @Mutation(() => SupportRequestPayload, {
    description:
      "Asks Hatti's people for help, as the signed-in member of staff, answered as the shop's " +
      `plan allows. At most ${SUPPORT_LIMITS.open} open at once.`,
  })
  async supportRequestCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: SupportRequestInput,
  ): Promise<SupportRequestPayload> {
    const result = await this.service.request(tenant, {
      topic: input.topic.toLowerCase(),
      message: input.message,
      language: input.language === SupportLanguage.URDU ? 'ur' : 'en',
      callBack: input.callBack ?? null,
    });
    return Object.assign(new SupportRequestPayload(), {
      request: result.ok ? toRequest(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SupportRequestPayload, {
    description: 'Closes one of the shop’s requests: answered enough, or no longer needed.',
  })
  async supportRequestClose(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SupportRequestPayload> {
    const uuid = tryFromPublicId(id, 'supportRequest');
    const closed = uuid ? await this.service.close(tenant, uuid) : null;
    return Object.assign(new SupportRequestPayload(), {
      request: closed && toRequest(closed),
      userErrors: closed ? [] : [UserError.of(['id'], 'NOT_FOUND', 'No such open request')],
    });
  }
}

function toRequest(record: SupportRequestRecord): SupportRequest {
  return Object.assign(new SupportRequest(), {
    id: toPublicId('supportRequest', record.id),
    topic: record.topic.toUpperCase() as SupportTopic,
    message: record.message,
    callBack: record.callBack,
    status: record.status.toUpperCase() as SupportRequestStatus,
    answer: record.answer,
    answeredBy: record.answeredBy,
    answeredAt: record.answeredAt,
    createdAt: record.createdAt,
  });
}
