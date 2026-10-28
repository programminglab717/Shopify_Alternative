import { AiGateway } from '@hatti/ai';
import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Inject, Optional } from '@nestjs/common';
import { Args, Field, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { SupportAgentService, type SupportAgentSettingsRecord } from '../support-agent.service.js';

@ObjectType({
  description:
    "The AI answering the shop's customers on WhatsApp and in its web chat (MSG-07, ADR-849), " +
    "from its policies and the customer's own orders, handing over to staff when it should.",
})
export class SupportAgent {
  @Field({ description: 'Whether the shop turned it on.' })
  enabled!: boolean;

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
    return Object.assign(new SupportAgent(), { ...record, available: Boolean(this.ai) });
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
}
