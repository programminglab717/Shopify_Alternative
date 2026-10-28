import { CurrentTenant, RequireScopes, UserError, failOne, type TenantContext } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import {
  Args,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { AppFunctionService, type AppFunctionRecord } from '../app-functions.service.js';

@ObjectType({
  description:
    "A function an app gives the shop's checkout (DEV-07, ADR-868): a WebAssembly module checkout " +
    'runs on what it is about to offer, once the owner or a manager turns it on.',
})
export class AppFunction {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { description: 'The app giving it.' })
  appId!: string;

  @Field()
  appName!: string;

  @Field({ description: 'The app\'s own name for it: "cod-above-limit".' })
  handle!: string;

  @Field()
  title!: string;

  @Field({
    description:
      'payment_customization, hiding ways to pay; or cart_validation, refusing an order with a ' +
      'message.',
  })
  target!: string;

  @Field(() => Int, { description: 'The module’s size as it runs.' })
  bytes!: number;

  @Field({ description: 'Whether checkout runs it: off until the shop turns it on.' })
  enabled!: boolean;

  @Field({ description: 'Its settings, as JSON: the function reads them as configuration.' })
  configuration!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Its last failure: past its time, or no answer.',
  })
  lastError!: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  failedAt!: Date | null;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@InputType()
export class AppFunctionInput {
  @Field()
  handle!: string;

  @Field()
  title!: string;

  @Field({ description: 'payment_customization or cart_validation.' })
  target!: string;

  @Field({
    description:
      'The module, base64: a WASI command reading its input as JSON on standard input and ' +
      'writing its answer as JSON on standard output, 256 KiB at most.',
  })
  wasm!: string;
}

@ObjectType()
export class AppFunctionPayload {
  @Field(() => AppFunction, { nullable: true })
  appFunction!: AppFunction | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class AppFunctionDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedAppFunctionId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

const toFunction = (record: AppFunctionRecord) =>
  Object.assign(new AppFunction(), {
    ...record,
    id: toPublicId('appFunction', record.id),
    appId: toPublicId('accessToken', record.appId),
    configuration: JSON.stringify(record.configuration),
  });

const payload = (result: Awaited<ReturnType<AppFunctionService['set']>>) =>
  Object.assign(new AppFunctionPayload(), {
    appFunction: result.ok ? toFunction(result.value) : null,
    userErrors: result.ok ? [] : UserError.list(result.errors),
  });

/** Apps' checkout functions (ADR-868): given by apps, turned on by the shop. */
@Resolver(() => AppFunction)
export class AppFunctionResolver {
  constructor(private readonly functions: AppFunctionService) {}

  @Query(() => [AppFunction], {
    description: "The calling app's functions; for staff, every app's the shop has.",
  })
  @RequireScopes('read_settings')
  async appFunctions(@CurrentTenant() tenant: TenantContext): Promise<AppFunction[]> {
    return (await this.functions.list(tenant)).map(toFunction);
  }

  @Mutation(() => AppFunctionPayload, {
    description:
      "Gives the calling app's function, or a new version of it by its handle: off until the " +
      'shop turns it on, and as it was for a new version.',
  })
  @RequireScopes('write_settings')
  async appFunctionSet(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: AppFunctionInput,
  ): Promise<AppFunctionPayload> {
    return payload(await this.functions.set(tenant, input));
  }

  @Mutation(() => AppFunctionDeletePayload, {
    description: "Takes back the calling app's function.",
  })
  @RequireScopes('write_settings')
  async appFunctionDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('handle') handle: string,
  ): Promise<AppFunctionDeletePayload> {
    const result = await this.functions.remove(tenant, handle);
    return Object.assign(new AppFunctionDeletePayload(), {
      deletedAppFunctionId: result.ok ? toPublicId('appFunction', result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => AppFunctionPayload, {
    description:
      "Turns an app's function on or off, with its settings as JSON where given: the owner's " +
      "and managers' to do.",
  })
  @RequireScopes('write_settings')
  async appFunctionEnable(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('enabled') enabled: boolean,
    @Args('configuration', { type: () => String, nullable: true }) configuration?: string | null,
  ): Promise<AppFunctionPayload> {
    const uuid = tryFromPublicId(id, 'appFunction');
    if (!uuid) {
      return payload(failOne<AppFunctionRecord>(['id'], 'NOT_FOUND', 'No app gives this function'));
    }
    return payload(await this.functions.enable(tenant, uuid, enabled, configuration));
  }
}
