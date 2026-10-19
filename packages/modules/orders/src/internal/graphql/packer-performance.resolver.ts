import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  deniedToRole,
  hasCapability,
  pageSize,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { PackerPerformanceService } from '../packer-performance.service.js';
import { ConfirmationAgentKind } from './agent-performance.types.js';
import { Packer, PackersArgs } from './packer-performance.types.js';

@Resolver()
export class PackerPerformanceResolver {
  constructor(private readonly performance: PackerPerformanceService) {}

  @Query(() => [Packer], {
    description:
      "Packers' performance (APP-04, COD-11): for each member of staff or app who marked orders " +
      'as packed over a period, the orders packed that nobody has unpacked since, the units in ' +
      'them, and their hours at it; those who packed most first. Owners and managers see every ' +
      'packer, and apps with read_orders; packers see themselves alone. Worked out when asked.',
  })
  @RequireScopes('read_orders')
  async packers(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: PackersArgs,
  ): Promise<Packer[]> {
    const actor = tenant.actor;
    let onlyStaff: string | undefined;
    // Staff who see how every packer did: owners and managers, and custom roles that keep it
    // (ADR-578). Packers, custom or not, see themselves.
    if (actor.kind === 'staff' && !hasCapability(actor, 'see_staff_performance')) {
      if (actor.role !== 'packer') {
        throw deniedToRole('Access denied. Only owners, managers and packers see packing counts.');
      }
      onlyStaff = actor.userId;
    }
    const result = await this.performance.report(tenant, {
      from: args.from,
      before: args.before,
      first: pageSize(args.first),
      onlyStaff,
    });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return result.value.map((row) =>
      Object.assign(new Packer(), {
        kind: row.packer.kind === 'app' ? ConfirmationAgentKind.APP : ConfirmationAgentKind.STAFF,
        id: toPublicId(row.packer.kind === 'app' ? 'accessToken' : 'user', row.packer.id),
        packed: row.packed,
        units: row.units,
        activeHours: row.activeHours,
        packedPerHour:
          row.activeHours === 0 ? null : Math.round((row.packed / row.activeHours) * 100) / 100,
      }),
    );
  }
}
