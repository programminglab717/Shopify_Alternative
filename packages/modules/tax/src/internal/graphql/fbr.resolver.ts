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
import type { FbrEnvironment as FbrEnvironmentValue, FiscalStatus } from '../fbr.js';
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
} from './fbr.types.js';

@Resolver(() => FbrPos)
export class FbrPosResolver {
  constructor(
    private readonly pos: FbrPosService,
    private readonly fiscal: FiscalInvoicesService,
  ) {}

  @Query(() => FbrPos, {
    nullable: true,
    description: "The shop's POS as FBR registered it; null while it has none connected.",
  })
  @RequireScopes('read_settings')
  async fbrPos(@CurrentTenant() tenant: TenantContext): Promise<FbrPos | null> {
    const record = await this.pos.get(tenant);
    return record && toFbrPos(record);
  }

  @Mutation(() => FbrPosUpdatePayload, {
    description:
      "Connects the shop's POS to FBR, or changes what it gave (POS-04, ADR-555): from then on, " +
      'each invoice and credit note it issues is reported to FBR as it is issued. Audited, the ' +
      'token never. Staff confirm who they are first when they signed in over 15 minutes ago.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async fbrPosUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: FbrPosInput,
  ): Promise<FbrPosUpdatePayload> {
    const result = await this.pos.update(tenant, {
      ...input,
      environment: input.environment && (input.environment.toLowerCase() as FbrEnvironmentValue),
    });
    return Object.assign(new FbrPosUpdatePayload(), {
      fbrPos: result.ok ? toFbrPos(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => FbrPosDeletePayload, {
    description:
      "Disconnects the shop's POS from FBR: its token is forgotten, and invoices are not reported " +
      'from now on, those still waiting among them.',
  })
  @RequireScopes('write_settings')
  async fbrPosDelete(@CurrentTenant() tenant: TenantContext): Promise<FbrPosDeletePayload> {
    return Object.assign(new FbrPosDeletePayload(), {
      deletedPosId: await this.pos.delete(tenant),
      userErrors: [],
    });
  }

  @Query(() => [FiscalInvoice], {
    description:
      'The invoices and credit notes the shop issued while its POS was connected, the latest ' +
      'first, with how reporting each to FBR went.',
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
      'put right why, while its POS is connected.',
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
