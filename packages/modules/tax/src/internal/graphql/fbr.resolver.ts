import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  failOne,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  FbrPosService,
  FiscalInvoicesService,
  type FbrPosRecord,
  type FiscalInvoiceRecord,
} from '../fbr-pos.service.js';
import type {
  FbrEnvironment as FbrEnvironmentValue,
  FbrSystem as FbrSystemValue,
  FiscalStatus,
} from '../fbr.js';
import {
  FbrEnvironment,
  FbrPos,
  FbrPosDeletePayload,
  FbrPosInput,
  FbrPosUpdatePayload,
  FiscalInvoice,
  FiscalInvoiceKind,
  FiscalInvoiceRetryPayload,
  FiscalInvoicesArgs,
  FiscalInvoiceStatus,
  FbrSystem,
} from './fbr.types.js';

@Resolver(() => FbrPos)
export class FbrPosResolver {
  constructor(
    private readonly pos: FbrPosService,
    private readonly fiscal: FiscalInvoicesService,
  ) {}

  @Query(() => FbrPos, {
    nullable: true,
    description:
      "The shop's connection to FBR, its POS or digital invoicing; null while it has none.",
  })
  @RequireScopes('read_settings')
  async fbrPos(@CurrentTenant() tenant: TenantContext): Promise<FbrPos | null> {
    const record = await this.pos.get(tenant);
    return record && toFbrPos(record);
  }

  @Mutation(() => FbrPosUpdatePayload, {
    description:
      "Connects the shop's POS to FBR, or FBR's digital invoicing, or changes what it gave " +
      '(POS-04, TAX-04, ADR-555, ADR-562): from then on, each invoice it issues is reported to ' +
      "FBR as it is issued, and each credit note to FBR's IMS. Audited, the token never. Staff " +
      'confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async fbrPosUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: FbrPosInput,
  ): Promise<FbrPosUpdatePayload> {
    const result = await this.pos.update(tenant, {
      ...input,
      system: input.system && (input.system.toLowerCase() as FbrSystemValue),
      environment: input.environment && (input.environment.toLowerCase() as FbrEnvironmentValue),
    });
    return Object.assign(new FbrPosUpdatePayload(), {
      fbrPos: result.ok ? toFbrPos(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => FbrPosDeletePayload, {
    description:
      'Disconnects the shop from FBR, its POS or digital invoicing: its token is forgotten, and ' +
      'invoices are not reported from now on, those still waiting among them.',
  })
  @RequireScopes('write_settings')
  async fbrPosDelete(@CurrentTenant() tenant: TenantContext): Promise<FbrPosDeletePayload> {
    const deleted = await this.pos.delete(tenant);
    return Object.assign(new FbrPosDeletePayload(), {
      deletedSystem: deleted && (deleted.system.toUpperCase() as FbrSystem),
      deletedPosId: deleted?.posId ?? null,
      userErrors: [],
    });
  }

  @Query(() => [FiscalInvoice], {
    description:
      'The invoices and credit notes the shop issued while connected to FBR, the latest first, ' +
      'with how reporting each to FBR went.',
  })
  @RequireScopes('read_settings')
  async fiscalInvoices(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: FiscalInvoicesArgs,
  ): Promise<FiscalInvoice[]> {
    const records = await this.fiscal.list(tenant, {
      status: args.status && (args.status.toLowerCase() as FiscalStatus),
      first: args.first,
    });
    return records.map(toFiscalInvoice);
  }

  @Mutation(() => FiscalInvoiceRetryPayload, {
    description:
      'Reports again one FBR refused, or one that disconnecting left unsent, once the shop has ' +
      'put right why, while it reports through what the invoice was kept for.',
  })
  @RequireScopes('write_settings')
  async fiscalInvoiceRetry(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FiscalInvoiceRetryPayload> {
    const uuid = tryFromPublicId(id, 'fiscalInvoice');
    const result = uuid
      ? await this.fiscal.retry(tenant, uuid)
      : failOne<FiscalInvoiceRecord>(['id'], 'NOT_FOUND', 'No such fiscal invoice');
    return Object.assign(new FiscalInvoiceRetryPayload(), {
      fiscalInvoice: result.ok ? toFiscalInvoice(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

function toFbrPos(record: FbrPosRecord): FbrPos {
  return Object.assign(new FbrPos(), {
    system: record.system.toUpperCase() as FbrSystem,
    posId: record.posId,
    accessTokenHint: record.tokenHint,
    environment: record.environment.toUpperCase() as FbrEnvironment,
    pctCode: record.pctCode,
    updatedAt: record.updatedAt,
  });
}

function toFiscalInvoice(record: FiscalInvoiceRecord): FiscalInvoice {
  return Object.assign(new FiscalInvoice(), {
    id: toPublicId('fiscalInvoice', record.id),
    system: record.system.toUpperCase() as FbrSystem,
    kind: record.kind.toUpperCase() as FiscalInvoiceKind,
    usin: record.usin,
    orderId: toPublicId('order', record.orderId),
    status: record.status.toUpperCase() as FiscalInvoiceStatus,
    fbrInvoiceNumber: record.fbrInvoiceNumber,
    attempts: record.attempts,
    error: record.error,
    reportedAt: record.reportedAt,
    createdAt: record.createdAt,
  });
}
