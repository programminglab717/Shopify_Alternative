import {
  ACCESS_SCOPES,
  CurrentTenant,
  RequireRecentAuthentication,
  RequireScopes,
  UserError,
  deniedToRole,
  hasCapability,
  hasScope,
  type TenantContext,
} from '@hatti/api';
import { CustomAppService } from '@hatti/apps/public';
import {
  Args,
  Field,
  GraphQLISODateTime,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { CliLogins, type CliAccess } from '../cli-logins.js';

export enum CliLoginAccess {
  READ = 'READ',
  WRITE = 'WRITE',
}

registerEnumType(CliLoginAccess, {
  name: 'CliLoginAccess',
  valuesMap: {
    READ: { description: 'Reads what the role reads, and changes nothing.' },
    WRITE: { description: 'Reads and changes what the role does: every scope the role holds.' },
  },
});

export enum CliLoginStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  DENIED = 'DENIED',
}

registerEnumType(CliLoginStatus, { name: 'CliLoginStatus' });

@ObjectType({
  description:
    "A terminal's `hatti login` waiting to be approved (DEV-08, ADR-990): approving it makes a " +
    'custom app for the terminal, whose token it is given once.',
})
export class CliLogin {
  @Field({ description: 'The code the terminal shows: XXXX-XXXX.' })
  code!: string;

  @Field({ description: 'The name the terminal gave itself, as a rule its computer’s.' })
  device!: string;

  @Field(() => CliLoginAccess, { description: 'What the terminal asked for.' })
  access!: CliLoginAccess;

  @Field(() => String, {
    nullable: true,
    description: 'The address it asked from, as the API saw it.',
  })
  requestedFrom!: string | null;

  @Field(() => CliLoginStatus)
  status!: CliLoginStatus;

  @Field(() => GraphQLISODateTime)
  expiresAt!: Date;
}

@ObjectType()
export class CliLoginApprovePayload {
  @Field(() => String, {
    nullable: true,
    description: 'The custom app made for the terminal, as Settings › Apps lists it.',
  })
  appName!: string | null;

  @Field(() => [String], { description: 'The scopes its token was given.' })
  scopes!: string[];

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class CliLoginDenyPayload {
  @Field()
  denied!: boolean;
}

const GONE = 'This login has ended or was answered: run hatti login again';

/** The scopes a login is given: the role's reads alone, or all it holds. */
export function cliScopesOf(tenant: TenantContext, access: CliAccess): string[] {
  return ACCESS_SCOPES.filter(
    (scope) => (access === 'write' || scope.startsWith('read_')) && hasScope(tenant, scope),
  );
}

/** Only those who make the shop's apps approve a terminal: it is given one. */
function approvesLogins(tenant: TenantContext): void {
  if (tenant.actor.kind !== 'staff' || !hasCapability(tenant.actor, 'manage_apps')) {
    throw deniedToRole(
      "Access denied. A terminal is let in by the shop's owner or a manager, as apps are.",
    );
  }
}

/**
 * The admin's side of `hatti login` (ADR-990): the login a code names, approved for the open shop
 * with a custom app of its own, named for the terminal, or refused. And, for any caller, the
 * scopes it holds, which `hatti whoami` shows.
 */
@Resolver(() => CliLogin)
export class CliLoginResolver {
  constructor(
    private readonly logins: CliLogins,
    private readonly apps: CustomAppService,
  ) {}

  @Query(() => CliLogin, {
    nullable: true,
    description: 'The `hatti login` a code names; null for none, or one that has ended.',
  })
  @RequireScopes('read_settings')
  async cliLogin(
    @CurrentTenant() tenant: TenantContext,
    @Args('code') code: string,
  ): Promise<CliLogin | null> {
    approvesLogins(tenant);
    const login = await this.logins.describe(code);
    if (!login) return null;
    return Object.assign(new CliLogin(), {
      code: login.userCode,
      device: login.device,
      access: login.access === 'read' ? CliLoginAccess.READ : CliLoginAccess.WRITE,
      requestedFrom: login.requestedFrom,
      status: login.status.toUpperCase() as CliLoginStatus,
      expiresAt: login.expiresAt,
    });
  }

  @Mutation(() => CliLoginApprovePayload, {
    description:
      'Lets the terminal showing the code in to the shop: a custom app named for it is made, ' +
      'with the scopes `access` gives of your role’s, and its token handed to the terminal once.',
  })
  @RequireScopes('write_settings')
  @RequireRecentAuthentication()
  async cliLoginApprove(
    @CurrentTenant() tenant: TenantContext,
    @Args('code') code: string,
    @Args('access', { type: () => CliLoginAccess }) access: CliLoginAccess,
  ): Promise<CliLoginApprovePayload> {
    approvesLogins(tenant);
    const failed = (message: string, errorCode = 'NOT_FOUND') =>
      Object.assign(new CliLoginApprovePayload(), {
        appName: null,
        scopes: [],
        userErrors: [UserError.of(['code'], errorCode, message)],
      });
    const login = await this.logins.describe(code);
    if (!login || login.status !== 'pending' || !(await this.logins.claim(code))) {
      return failed(GONE);
    }
    const scopes = cliScopesOf(tenant, access === CliLoginAccess.READ ? 'read' : 'write');
    const made = await this.apps.create(tenant, {
      name: `Hatti CLI · ${login.device}`,
      scopes,
    });
    if (!made.ok) {
      return Object.assign(new CliLoginApprovePayload(), {
        appName: null,
        scopes: [],
        userErrors: UserError.list(made.errors),
      });
    }
    const { app, accessToken } = made.value;
    if (!(await this.logins.approve(code, { accessToken, shopId: tenant.shopId, scopes }))) {
      // Ended while the app was made: the token no terminal will fetch goes too.
      await this.apps.delete(tenant, app.id);
      return failed(GONE);
    }
    return Object.assign(new CliLoginApprovePayload(), {
      appName: app.name,
      scopes: app.scopes,
      userErrors: [],
    });
  }

  @Mutation(() => CliLoginDenyPayload, {
    description: 'Refuses the terminal showing the code: it is told, and given nothing.',
  })
  @RequireScopes('read_settings')
  async cliLoginDeny(
    @CurrentTenant() tenant: TenantContext,
    @Args('code') code: string,
  ): Promise<CliLoginDenyPayload> {
    approvesLogins(tenant);
    return Object.assign(new CliLoginDenyPayload(), { denied: await this.logins.deny(code) });
  }

  @Query(() => [String], {
    description:
      "The access scopes the caller holds: an app's token's, or a member of staff's role's.",
  })
  accessScopes(@CurrentTenant() tenant: TenantContext): string[] {
    return ACCESS_SCOPES.filter((scope) => tenant.scopes.has(scope));
  }
}
