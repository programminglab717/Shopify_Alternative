import { AiGateway } from '@hatti/ai';
import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Inject, Optional } from '@nestjs/common';
import {
  Args,
  Field,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import {
  SUPPORT_AGENT_NAME_MAX,
  SUPPORT_FAQ_LIMITS,
  SUPPORT_TONES,
  SupportAgentService,
  type SupportAgentSettingsRecord,
} from '../support-agent.service.js';

@ObjectType({
  description: "A question the shop's customers ask, and the shop's answer (ADR-911).",
})
export class SupportAgentFaq {
  @Field()
  question!: string;

  @Field()
  answer!: string;
}

@InputType()
export class SupportAgentFaqInput {
  @Field({ description: `${SUPPORT_FAQ_LIMITS.question} characters at most.` })
  question!: string;

  @Field({ description: `${SUPPORT_FAQ_LIMITS.answer} characters at most.` })
  answer!: string;
}

@ObjectType({
  description:
    "The AI answering the shop's customers on WhatsApp and in its web chat (MSG-07, ADR-849), " +
    'from its policies, its answers to common questions, the products asked of and the ' +
    "customer's own orders, handing over to staff when it should.",
})
export class SupportAgent {
  @Field({ description: 'Whether the shop turned it on.' })
  enabled!: boolean;

  @Field(() => [SupportAgentFaq], {
    description:
      "The shop's answers to its customers' common questions, which the AI answers from.",
  })
  faqs!: SupportAgentFaq[];

  @Field(() => String, {
    nullable: true,
    description:
      'The name the shop gave its assistant, which it answers as (ADR-923); null for none.',
  })
  name!: string | null;

  @Field({ description: `How it writes: ${SUPPORT_TONES.join(' or ')} (ADR-923).` })
  tone!: string;

  @Field({ description: 'Whether Hatti answers at all: false until its AI is set up.' })
  available!: boolean;

  @Field(() => Int, { description: 'Messages it answered in the last day.' })
  answeredToday!: number;

  @Field(() => Int)
  limitPerDay!: number;
}

@ObjectType()
export class SupportAgentUpdatePayload {
  @Field(() => SupportAgent, { nullable: true })
  supportAgent!: SupportAgent | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** The shop's AI support agent, kept by those who change its settings (ADR-849). */
@Resolver(() => SupportAgent)
export class SupportAgentResolver {
  constructor(
    private readonly agent: SupportAgentService,
    @Optional() @Inject(AiGateway) private readonly ai?: AiGateway | null,
  ) {}

  #shown(record: SupportAgentSettingsRecord): SupportAgent {
    return Object.assign(new SupportAgent(), {
      ...record,
      name: record.voice.name,
      tone: record.voice.tone,
      available: Boolean(this.ai),
    });
  }

  @Query(() => SupportAgent, { description: "Whether the AI answers the shop's customers." })
  @RequireScopes('read_settings')
  async supportAgent(@CurrentTenant() tenant: TenantContext): Promise<SupportAgent> {
    return this.#shown(await this.agent.settings(tenant));
  }

  @Mutation(() => SupportAgentUpdatePayload, {
    description:
      "Turns the AI's answers to customers on or off. Each answer spends an AI credit; staff " +
      'answering a conversation, or taking it, leave it theirs.',
  })
  @RequireScopes('write_settings')
  async supportAgentUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('enabled') enabled: boolean,
  ): Promise<SupportAgentUpdatePayload> {
    const result = await this.agent.update(tenant, { enabled });
    return Object.assign(new SupportAgentUpdatePayload(), {
      supportAgent: result.ok ? this.#shown(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SupportAgentUpdatePayload, {
    description:
      `Names the shop's assistant, ${SUPPORT_AGENT_NAME_MAX} characters at most, or leaves it ` +
      `unnamed with a blank name, and sets how it writes: ${SUPPORT_TONES.join(' or ')} (ADR-923).`,
  })
  @RequireScopes('write_settings')
  async supportAgentVoiceSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('name', { type: () => String, nullable: true }) name: string | null,
    @Args('tone') tone: string,
  ): Promise<SupportAgentUpdatePayload> {
    const result = await this.agent.setVoice(tenant, { name, tone });
    return Object.assign(new SupportAgentUpdatePayload(), {
      supportAgent: result.ok ? this.#shown(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => SupportAgentUpdatePayload, {
    description:
      `Sets the shop's answers to its customers' common questions, in order, ` +
      `${SUPPORT_FAQ_LIMITS.faqs} at most, for the AI to answer from (ADR-911).`,
  })
  @RequireScopes('write_settings')
  async supportAgentFaqsSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('faqs', { type: () => [SupportAgentFaqInput] }) faqs: SupportAgentFaqInput[],
  ): Promise<SupportAgentUpdatePayload> {
    const result = await this.agent.setFaqs(tenant, faqs);
    return Object.assign(new SupportAgentUpdatePayload(), {
      supportAgent: result.ok ? this.#shown(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
