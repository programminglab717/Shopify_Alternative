import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import {
  Field,
  Float,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import {
  STORE_EXPORT_LIMITS,
  STORE_EXPORT_URL_SECONDS,
  StoreExportService,
  type StoreExportRecord,
} from '../store-export.service.js';

export enum StoreExportStatus {
  PENDING = 'PENDING',
  READY = 'READY',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

registerEnumType(StoreExportStatus, {
  name: 'StoreExportStatus',
  description:
    'PENDING while a worker makes it, READY to download for a week, FAILED, or EXPIRED once ' +
    'storage let it go.',
});

@ObjectType({
  description:
    'The whole store exported (ADM-10, ADR-415): a ZIP of its products and stock, customers, ' +
    'orders and their line items, and redirects, each as its own export writes it.',
})
export class StoreExport {
  @Field(() => ID)
  id!: string;

  @Field(() => StoreExportStatus)
  status!: StoreExportStatus;

  @Field(() => Float, { nullable: true, description: 'Bytes of the ZIP, once ready.' })
  size!: number | null;

  @Field(() => String, { nullable: true, description: 'Why it failed.' })
  error!: string | null;

  @Field()
  createdAt!: Date;

  @Field(() => Date, { nullable: true })
  finishedAt!: Date | null;

  @Field(() => Date, { nullable: true, description: 'When storage lets the ZIP go.' })
  expiresAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: `A link that downloads the ZIP, for ${STORE_EXPORT_URL_SECONDS / 60} minutes, once ready.`,
  })
  url!: string | null;
}

@ObjectType()
export class StoreExportCreatePayload {
  @Field(() => StoreExport, { nullable: true })
  storeExport!: StoreExport | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** The owner alone exports the whole store: never other staff, nor apps. */
function owner(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff' || tenant.actor.role !== 'owner') {
    throw deniedToRole("Access denied. Only the shop's owner exports the whole store.");
  }
}

/** The whole store exported (ADM-10, ADR-415), by its owner. */
@Resolver(() => StoreExport)
export class StoreExportResolver {
  constructor(private readonly service: StoreExportService) {}

  @Query(() => [StoreExport], {
    description: `The shop's latest ${STORE_EXPORT_LIMITS.listed} exports of the whole store, newest first. The owner's alone.`,
  })
  @RequireScopes('read_products', 'read_customers', 'read_orders')
  async storeExports(@CurrentTenant() tenant: TenantContext): Promise<StoreExport[]> {
    owner(tenant);
    return (await this.service.list(tenant)).map((record) => this.#toExport(record));
  }

  @Mutation(() => StoreExportCreatePayload, {
    description:
      'Asks for the whole store, exported: a worker makes the ZIP as the owner asking, ready in ' +
      `a few minutes, which storeExports then links for a week. One at a time, at most ${STORE_EXPORT_LIMITS.perDay} ` +
      'a day. The owner’s alone, who must have proved who they are in the last few minutes.',
  })
  @RequireScopes('read_products', 'read_customers', 'read_orders')
  @RequireRecentAuthentication()
  async storeExportCreate(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<StoreExportCreatePayload> {
    owner(tenant);
    const result = await this.service.request(tenant);
    return Object.assign(new StoreExportCreatePayload(), {
      storeExport: result.ok ? this.#toExport(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  #toExport(record: StoreExportRecord): StoreExport {
    return Object.assign(new StoreExport(), {
      id: toPublicId('storeExport', record.id),
      status: record.status.toUpperCase() as StoreExportStatus,
      size: record.size,
      error: record.error,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
      expiresAt: record.expiresAt,
      url: this.service.urlOf(record),
    });
  }
}
