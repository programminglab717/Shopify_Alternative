import {
  CurrentTenant,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { MessageLanguage as MessageLanguageValue } from '../templates.js';
import {
  WhatsAppTemplatesService,
  type WhatsAppTemplateRecord,
} from '../whatsapp-templates.service.js';
import type { MessageLanguage } from './messaging.types.js';
import {
  WhatsAppTemplate,
  WhatsAppTemplateCreatePayload,
  WhatsAppTemplateDeletePayload,
  WhatsAppTemplateInput,
  WhatsAppTemplatesSyncPayload,
  WhatsAppTemplateStatus,
} from './whatsapp-template.types.js';

@Resolver()
export class WhatsAppTemplateResolver {
  constructor(private readonly templates: WhatsAppTemplatesService) {}

  @Query(() => [WhatsAppTemplate], {
    description:
      "The shop's own WhatsApp templates on the number it has connected, the latest first; " +
      'none without one.',
  })
  @RequireScopes('read_marketing_events')
  async whatsAppTemplates(@CurrentTenant() tenant: TenantContext): Promise<WhatsAppTemplate[]> {
    return (await this.templates.list(tenant)).map(toTemplate);
  }

  @Mutation(() => WhatsAppTemplateCreatePayload, {
    description:
      "Writes a marketing template and sends it to Meta for approval on the shop's own " +
      'WhatsApp Business Account; it is kept once Meta has it.',
  })
  @RequireScopes('write_marketing_events')
  async whatsAppTemplateCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: WhatsAppTemplateInput,
  ): Promise<WhatsAppTemplateCreatePayload> {
    const result = await this.templates.create(tenant, {
      ...input,
      language: input.language.toLowerCase() as MessageLanguageValue,
    });
    return Object.assign(new WhatsAppTemplateCreatePayload(), {
      whatsAppTemplate: result.ok ? toTemplate(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => WhatsAppTemplateDeletePayload, {
    description: "Deletes one of the shop's templates, from Meta too.",
  })
  @RequireScopes('write_marketing_events')
  async whatsAppTemplateDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<WhatsAppTemplateDeletePayload> {
    const uuid = tryFromPublicId(id, 'whatsAppTemplate');
    if (!uuid) throw badUserInput(`Invalid template id: ${id.slice(0, 64)}`);
    const result = await this.templates.delete(tenant, uuid);
    return Object.assign(new WhatsAppTemplateDeletePayload(), {
      deletedWhatsAppTemplateId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => WhatsAppTemplatesSyncPayload, {
    description:
      "Asks Meta how the shop's templates stand, as its webhook says of them as it decides.",
  })
  @RequireScopes('write_marketing_events')
  async whatsAppTemplatesSync(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<WhatsAppTemplatesSyncPayload> {
    const result = await this.templates.sync(tenant);
    return Object.assign(new WhatsAppTemplatesSyncPayload(), {
      whatsAppTemplates: result.ok ? result.value.map(toTemplate) : [],
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

export function toTemplate(record: WhatsAppTemplateRecord): WhatsAppTemplate {
  return Object.assign(new WhatsAppTemplate(), {
    ...record,
    id: toPublicId('whatsAppTemplate', record.id),
    language: record.language.toUpperCase() as MessageLanguage,
    status: record.status.toUpperCase() as WhatsAppTemplateStatus,
  });
}
