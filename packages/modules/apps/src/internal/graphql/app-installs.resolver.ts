import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { AppInstallsService, type InstalledAppRecord } from '../app-installs.service.js';

@ObjectType({
  description:
    'A public app installed on the shop through OAuth (DEV-05, ADR-851): its owner or a manager ' +
    "approved what it reaches, and it holds a token of the shop's.",
})
export class InstalledApp {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { description: 'The app as its partner registered it.' })
  appId!: string;

  @Field()
  name!: string;

  @Field(() => [String])
  scopes!: string[];

  @Field(() => GraphQLISODateTime)
  installedAt!: Date;
}

@ObjectType()
export class AppUninstallPayload {
  @Field(() => ID, { nullable: true })
  uninstalledAppId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toInstalled = (record: InstalledAppRecord) =>
  Object.assign(new InstalledApp(), {
    id: toPublicId('accessToken', record.id),
    appId: toPublicId('partnerApp', record.publicAppId),
    name: record.name,
    scopes: record.scopes,
    installedAt: record.installedAt,
  });

/** The public apps installed on the shop (ADR-851), kept by those who change its settings. */
@Resolver(() => InstalledApp)
export class AppInstallsResolver {
  constructor(private readonly installs: AppInstallsService) {}

  @Query(() => [InstalledApp], { description: 'The public apps installed on the shop.' })
  @RequireScopes('read_settings')
  async installedApps(@CurrentTenant() tenant: TenantContext): Promise<InstalledApp[]> {
    return (await this.installs.installed(tenant)).map(toInstalled);
  }

  @Mutation(() => AppUninstallPayload, {
    description: 'Uninstalls a public app: its token stops working at once.',
  })
  @RequireScopes('write_settings')
  async appUninstall(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AppUninstallPayload> {
    const uuid = tryFromPublicId(id, 'accessToken');
    const result = uuid
      ? await this.installs.uninstall(tenant, uuid)
      : failOne<InstalledAppRecord>(['id'], 'NOT_FOUND', 'No such app is installed');
    return Object.assign(new AppUninstallPayload(), {
      uninstalledAppId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
