import {
  CurrentTenant,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import { tryFromPublicId } from '@hatti/ids';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  AutomationsService,
  type AutomationKind,
  type AutomationRecord,
} from '../automations.service.js';
import {
  MarketingAutomation,
  MarketingAutomationInput,
  MarketingAutomationKind,
  MarketingAutomationUpdatePayload,
} from './automation.types.js';
import { toTemplate } from './whatsapp-template.resolver.js';

@Resolver()
export class AutomationResolver {
  constructor(private readonly service: AutomationsService) {}

  @Query(() => [MarketingAutomation], {
    description: "The shop's automations, each as set, or off where it never was.",
  })
  @RequireScopes('read_marketing_events')
  async marketingAutomations(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<MarketingAutomation[]> {
    return (await this.service.list(tenant)).map(toAutomation);
  }

  @Mutation(() => MarketingAutomationUpdatePayload, {
    description:
      "Turns one of the shop's automations on or off, or changes its template or days: on only " +
      "with a template Meta approved on the shop's number.",
  })
  @RequireScopes('write_marketing_events')
  async marketingAutomationUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('kind', { type: () => MarketingAutomationKind }) kind: MarketingAutomationKind,
    @Args('input') input: MarketingAutomationInput,
  ): Promise<MarketingAutomationUpdatePayload> {
    let templateId: string | null | undefined = input.templateId;
    if (templateId) {
      const uuid = tryFromPublicId(templateId, 'whatsAppTemplate');
      if (!uuid) throw badUserInput(`Invalid template id: ${templateId.slice(0, 64)}`);
      templateId = uuid;
    }
    const result = await this.service.update(tenant, kind.toLowerCase() as AutomationKind, {
      enabled: input.enabled ?? undefined,
      templateId,
      afterDays: input.afterDays,
    });
    return Object.assign(new MarketingAutomationUpdatePayload(), {
      marketingAutomation: result.ok ? toAutomation(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toAutomation(record: AutomationRecord): MarketingAutomation {
  return Object.assign(new MarketingAutomation(), {
    ...record,
    kind: record.kind.toUpperCase() as MarketingAutomationKind,
    template: record.template && toTemplate(record.template),
  });
}
