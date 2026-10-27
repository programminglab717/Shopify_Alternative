import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import {
  Args,
  Field,
  GraphQLISODateTime,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { WebChatService, type WebChatSettingsRecord } from '../web-chat.service.js';

@ObjectType({
  description:
    "The chat on the shop's online store (MSG-10, ADR-810): shoppers write from its pages, giving " +
    'their name and mobile number, and its staff answer in the inbox.',
})
export class WebChatSettings {
  @Field({ description: 'Whether the online store offers the chat.' })
  enabled!: boolean;

  @Field(() => String, {
    nullable: true,
    description: "What the chat says before the shopper writes; null for Hatti's words.",
  })
  greeting!: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: 'When the shop last changed it; null for one never set.',
  })
  updatedAt!: Date | null;
}

@InputType()
export class WebChatSettingsInput {
  @Field({ nullable: true })
  enabled?: boolean;

  @Field(() => String, {
    nullable: true,
    description: "Up to 200 characters; null or blank for Hatti's words. Left out, it stays.",
  })
  greeting?: string | null;
}

@ObjectType()
export class WebChatSettingsUpdatePayload {
  @Field(() => WebChatSettings, { nullable: true })
  webChatSettings!: WebChatSettings | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@Resolver()
export class WebChatResolver {
  constructor(private readonly chat: WebChatService) {}

  @Query(() => WebChatSettings, { description: "The chat on the shop's online store." })
  @RequireScopes('read_settings')
  async webChatSettings(@CurrentTenant() tenant: TenantContext): Promise<WebChatSettings> {
    return toSettings(await this.chat.settings(tenant));
  }

  @Mutation(() => WebChatSettingsUpdatePayload, {
    description: "Turns the chat on the shop's online store on or off, or changes its greeting.",
  })
  @RequireScopes('write_settings')
  async webChatSettingsUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: WebChatSettingsInput,
  ): Promise<WebChatSettingsUpdatePayload> {
    const result = await this.chat.update(tenant, input);
    return Object.assign(new WebChatSettingsUpdatePayload(), {
      webChatSettings: result.ok ? toSettings(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

const toSettings = (record: WebChatSettingsRecord) => Object.assign(new WebChatSettings(), record);
