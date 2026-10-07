import {
  CurrentTenant,
  RequireScopes,
  StorefrontSite,
  UserError,
  type FieldError,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DomainService } from '../domain.service.js';
import type { DomainRecord } from '../records.js';
import {
  DomainCreateInput,
  DomainDeletePayload,
  DomainPayload,
  DomainUpdateInput,
  OnlineStoreDomain,
} from './domain.types.js';
import { uuidOf } from './mappers.js';

@Resolver(() => OnlineStoreDomain)
export class DomainResolver {
  constructor(
    private readonly service: DomainService,
    private readonly storefronts: StorefrontSite,
  ) {}

  @Query(() => [OnlineStoreDomain], {
    description: "The shop's own domains, the primary first, then as they were connected.",
  })
  @RequireScopes('read_domains')
  async domains(@CurrentTenant() tenant: TenantContext): Promise<OnlineStoreDomain[]> {
    return (await this.service.list(tenant)).map((record) => this.#toDomain(record));
  }

  @Mutation(() => DomainPayload, {
    description:
      "Connects a domain of the shop's own. Point it at the `dnsTarget` the answer names, then " +
      '`domainVerify` it: the storefront answers at it from then on.',
  })
  @RequireScopes('write_domains')
  async domainCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('domain') domain: DomainCreateInput,
  ): Promise<DomainPayload> {
    return this.#payload(await this.service.create(tenant, domain), inDomain);
  }

  @Mutation(() => DomainPayload, {
    description:
      'Asks DNS whether the domain points at the platform now, and marks it verified if it does; ' +
      'NOT_POINTED says what it points at otherwise.',
  })
  @RequireScopes('write_domains')
  async domainVerify(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DomainPayload> {
    return this.#payload(await this.service.verify(tenant, uuidOf('domain', id)));
  }

  @Mutation(() => DomainPayload, {
    description: 'Makes a verified domain primary, where the storefront sends shoppers, or not.',
  })
  @RequireScopes('write_domains')
  async domainUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('domain') domain: DomainUpdateInput,
  ): Promise<DomainPayload> {
    return this.#payload(await this.service.update(tenant, uuidOf('domain', id), domain), inDomain);
  }

  @Mutation(() => DomainDeletePayload, {
    description: 'Lets a domain go: the storefront no longer answers at it.',
  })
  @RequireScopes('write_domains')
  async domainDelete(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<DomainDeletePayload> {
    const result = await this.service.delete(tenant, uuidOf('domain', id));
    return Object.assign(new DomainDeletePayload(), {
      deletedDomainId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  #payload(
    result: { ok: true; value: DomainRecord } | { ok: false; errors: FieldError[] },
    fields: (errors: readonly FieldError[]) => FieldError[] = (errors) => [...errors],
  ): DomainPayload {
    return Object.assign(new DomainPayload(), {
      domain: result.ok ? this.#toDomain(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(fields(result.errors)),
    });
  }

  #toDomain(record: DomainRecord): OnlineStoreDomain {
    return Object.assign(new OnlineStoreDomain(), {
      id: toPublicId('domain', record.id),
      host: record.host,
      url: this.storefronts.urlAt(record.host),
      isVerified: record.verifiedAt !== null,
      verifiedAt: record.verifiedAt,
      unpointedSince: record.unpointedSince,
      isPrimary: record.isPrimary,
      dnsTarget: this.service.dnsTarget,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}

/** Errors on the domain's fields, where the request has them: under `domain`. */
function inDomain(errors: readonly FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field.length === 0 || error.field[0] === 'id'
      ? error
      : { ...error, field: ['domain', ...error.field] },
  );
}
