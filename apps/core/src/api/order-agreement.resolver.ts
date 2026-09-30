import { CurrentTenant, Loaders, RequestLoaders, type TenantContext } from '@hatti/api';
import {
  PolicyService,
  ShopPolicyVersion,
  toShopPolicyVersion,
  type PolicyVersionRecord,
} from '@hatti/online-store/public';
import { OrderAgreement } from '@hatti/orders/public';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';

/**
 * What an order's e-contract log shows of the shop's policies (ADR-057): the orders module keeps
 * which versions its customer agreed to, the online store keeps the versions, and the core puts
 * the two together, one query for a page of orders.
 */
@Resolver(() => OrderAgreement)
export class OrderAgreementResolver {
  constructor(private readonly shopPolicies: PolicyService) {}

  @ResolveField(() => [ShopPolicyVersion], {
    description:
      "The shop's policies its checkout linked, as they were then, in Shopify's order: whatever " +
      'they have become since.',
  })
  async policies(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() agreement: OrderAgreement,
  ): Promise<ShopPolicyVersion[]> {
    const loader = loaders.get<string, PolicyVersionRecord>('onlineStore.policyVersions', (ids) =>
      this.shopPolicies.versions(tenant, ids),
    );
    const found = await loader.loadMany(agreement.policyVersionIds);
    return found
      .filter(
        (version): version is PolicyVersionRecord =>
          version !== undefined && !(version instanceof Error),
      )
      .map(toShopPolicyVersion);
  }
}
