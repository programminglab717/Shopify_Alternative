import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  WhatsAppAccountsService,
  type WhatsAppAccountRecord,
} from '../whatsapp-accounts.service.js';
import {
  WhatsAppAccount,
  WhatsAppAccountConnectInput,
  WhatsAppAccountConnectPayload,
  WhatsAppAccountDisconnectPayload,
  WhatsAppQualityRating,
  WhatsAppSignup,
} from './whatsapp-account.types.js';

@Resolver()
export class WhatsAppAccountResolver {
  constructor(private readonly accounts: WhatsAppAccountsService) {}

  @Query(() => WhatsAppAccount, {
    nullable: true,
    description: "The shop's own WhatsApp number; null while it has none connected.",
  })
  @RequireScopes('read_settings')
  async whatsAppAccount(@CurrentTenant() tenant: TenantContext): Promise<WhatsAppAccount | null> {
    const record = await this.accounts.get(tenant);
    return record && toAccount(record);
  }

  @Query(() => WhatsAppSignup, {
    nullable: true,
    description:
      "What the admin starts Meta's Embedded Signup with; null where this server has none " +
      'set up.',
  })
  @RequireScopes('read_settings')
  whatsAppSignup(): WhatsAppSignup | null {
    const signup = this.accounts.signup();
    return signup && Object.assign(new WhatsAppSignup(), signup);
  }

  @Mutation(() => WhatsAppAccountConnectPayload, {
    description:
      "Connects the shop's own WhatsApp number with what Embedded Signup gave, in place of any " +
      "it had: the code is exchanged with Meta, Hatti's app hears the account's webhooks, and " +
      'the number is registered to send.',
  })
  @RequireScopes('write_settings')
  async whatsAppAccountConnect(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: WhatsAppAccountConnectInput,
  ): Promise<WhatsAppAccountConnectPayload> {
    const result = await this.accounts.connect(tenant, input);
    return Object.assign(new WhatsAppAccountConnectPayload(), {
      whatsAppAccount: result.ok ? toAccount(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => WhatsAppAccountDisconnectPayload, {
    description:
      "Disconnects the shop's own WhatsApp number: Hatti forgets its token and stops sending " +
      'from it.',
  })
  @RequireScopes('write_settings')
  async whatsAppAccountDisconnect(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<WhatsAppAccountDisconnectPayload> {
    return Object.assign(new WhatsAppAccountDisconnectPayload(), {
      disconnectedPhoneNumber: await this.accounts.disconnect(tenant),
      userErrors: [],
    });
  }
}

function toAccount(record: WhatsAppAccountRecord): WhatsAppAccount {
  return Object.assign(new WhatsAppAccount(), {
    ...record,
    qualityRating: record.qualityRating.toUpperCase() as WhatsAppQualityRating,
  });
}
