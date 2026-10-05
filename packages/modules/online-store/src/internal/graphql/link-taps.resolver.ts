import { CurrentTenant, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { LinkTapsService } from '../link-taps.service.js';
import {
  LinkPageTapsArgs,
  LinkPageTapsReport,
  LinkTapSource,
  LinkTaps,
} from './link-taps.types.js';

@Resolver()
export class LinkTapsResolver {
  constructor(private readonly taps: LinkTapsService) {}

  @Query(() => LinkPageTapsReport, {
    description:
      "Taps on the links of the shop's link page over a period (CH-07, ADR-204): which of its " +
      'links bring shoppers, its chat on WhatsApp among them. Robots and staff previews are left ' +
      'out. Kept from the storefronts every minute.',
  })
  @RequireScopes('read_orders')
  async linkPageTaps(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: LinkPageTapsArgs,
  ): Promise<LinkPageTapsReport> {
    const result = await this.taps.report(tenant, { from: args.from, before: args.before });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return Object.assign(new LinkPageTapsReport(), {
      total: result.value.total,
      links: result.value.links.map((link) =>
        Object.assign(new LinkTaps(), { ...link, source: link.source as LinkTapSource }),
      ),
    });
  }
}
