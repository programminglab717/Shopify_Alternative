import {
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { Args, Field, ID, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { CustomerTransferService, TRANSFER_LIMITS } from '../customer-transfer.service.js';
import { uuidOf } from './mappers.js';

@ObjectType({ description: 'A row an import could not take, and why.' })
export class CustomerImportRowError {
  @Field(() => Int, { description: 'Its row in the file; the header is row 1.' })
  row!: number;

  @Field(() => String, {
    nullable: true,
    description: 'The column at fault, as the file names it.',
  })
  column!: string | null;

  @Field()
  message!: string;
}

@ObjectType()
export class CustomersImportPayload {
  @Field(() => Int, { description: 'Rows after the header.' })
  rows!: number;

  @Field(() => Int)
  created!: number;

  @Field(() => Int)
  updated!: number;

  @Field(() => Int, { description: 'Customers already here, left as they were.' })
  skipped!: number;

  @Field(() => Int, { description: 'Rows that could not be taken; the rest were.' })
  rowErrorCount!: number;

  @Field(() => [CustomerImportRowError], {
    description: `The first ${TRANSFER_LIMITS.rowErrors} rows that could not be taken.`,
  })
  rowErrors!: CustomerImportRowError[];

  @Field({ description: 'Nothing was written: the counts say what would happen.' })
  dryRun!: boolean;

  @Field(() => [UserError], { description: 'Problems with the whole file; nothing was written.' })
  userErrors!: UserError[];
}

@ObjectType()
export class CustomersExportPayload {
  @Field(() => String, {
    nullable: true,
    description: 'The customers as CSV, UTF-8 with a byte-order mark, for Excel and re-import.',
  })
  csv!: string | null;

  @Field(() => Int)
  rowCount!: number;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@Resolver()
export class CustomerTransferResolver {
  constructor(private readonly service: CustomerTransferService) {}

  @Mutation(() => CustomersImportPayload, {
    description:
      `Adds customers from CSV, up to ${TRANSFER_LIMITS.importRows.toLocaleString('en')} rows: ` +
      "Hatti's own export, Shopify's customer export, or a spreadsheet with a Phone column. " +
      'Rows that fail are reported, and the rest go in.',
  })
  @RequireScopes('write_customers')
  async customersImport(
    @CurrentTenant() tenant: TenantContext,
    @Args('csv') csv: string,
    @Args('overwrite', {
      nullable: true,
      description:
        "Customers already here take the file's name, email, note, tags and consent. Default false.",
    })
    overwrite?: boolean,
    @Args('dryRun', {
      nullable: true,
      description: 'Check the file and count what would happen, writing nothing.',
    })
    dryRun?: boolean,
  ): Promise<CustomersImportPayload> {
    const result = await this.service.import(tenant, csv, {
      overwrite: overwrite ?? false,
      dryRun: dryRun ?? false,
    });
    if (!result.ok) {
      return Object.assign(new CustomersImportPayload(), {
        rows: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        rowErrorCount: 0,
        rowErrors: [],
        dryRun: dryRun ?? false,
        userErrors: UserError.list(result.errors),
      });
    }
    return Object.assign(new CustomersImportPayload(), {
      ...result.value,
      rowErrors: result.value.rowErrors.map((error) =>
        Object.assign(new CustomerImportRowError(), error),
      ),
      userErrors: [],
    });
  }

  @Mutation(() => CustomersExportPayload, {
    description:
      'Customers as CSV: everyone, a saved segment, or a segment query, up to ' +
      `${TRANSFER_LIMITS.exportRows.toLocaleString('en')}. Owners and managers only; every ` +
      'export is recorded. Staff confirm who they are first when they signed in over 15 ' +
      'minutes ago.',
  })
  @RequireScopes('write_customers')
  @RequireRecentAuthentication()
  async customersExport(
    @CurrentTenant() tenant: TenantContext,
    @Args('query', { type: () => String, nullable: true }) query?: string | null,
    @Args('segmentId', { type: () => ID, nullable: true }) segmentId?: string | null,
  ): Promise<CustomersExportPayload> {
    const result = await this.service.export(tenant, {
      query,
      segmentId: segmentId ? uuidOf('segment', segmentId) : null,
    });
    return Object.assign(new CustomersExportPayload(), {
      csv: result.ok ? result.value.csv : null,
      rowCount: result.ok ? result.value.rowCount : 0,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
