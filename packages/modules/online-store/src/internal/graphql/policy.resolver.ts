import {
  CurrentTenant,
  RequireScopes,
  UserError,
  type FieldError,
  type TenantContext,
} from '@hatti/api';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { PolicyService } from '../policy.service.js';
import { toShopPolicy } from './mappers.js';
import { ShopPolicy, ShopPolicyInput, ShopPolicyUpdatePayload } from './policy.types.js';

/** Shop policies, as Shopify's are (ADR-056); the shop's own list is `shop { shopPolicies }`. */
@Resolver(() => ShopPolicy)
export class PolicyResolver {
  constructor(private readonly service: PolicyService) {}

  @Mutation(() => ShopPolicyUpdatePayload, {
    description:
      "Sets one of the shop's policies, or takes it away with a blank body; the storefront " +
      'shows it a moment later.',
  })
  @RequireScopes('write_legal_policies')
  async shopPolicyUpdate(
    @CurrentTenant() tenant: TenantContext,
    @Args('shopPolicy') shopPolicy: ShopPolicyInput,
  ): Promise<ShopPolicyUpdatePayload> {
    const result = await this.service.update(tenant, shopPolicy);
    const url = result.ok && result.value ? await this.service.storefrontUrl(tenant) : '';
    return Object.assign(new ShopPolicyUpdatePayload(), {
      shopPolicy: result.ok && result.value ? toShopPolicy(result.value, url) : null,
      userErrors: result.ok ? [] : UserError.list(inShopPolicy(result.errors)),
    });
  }
}

/** Errors on the policy's fields, where the request has them: under `shopPolicy`. */
function inShopPolicy(errors: readonly FieldError[]): FieldError[] {
  return errors.map((error) =>
    error.field.length === 0 ? error : { ...error, field: ['shopPolicy', ...error.field] },
  );
}
