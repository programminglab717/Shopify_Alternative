import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  deniedToRole,
  pageSize,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { AgentPerformanceService } from '../agent-performance.service.js';
import {
  ConfirmationAgent,
  ConfirmationAgentCalls,
  ConfirmationAgentKind,
  ConfirmationAgentsArgs,
} from './agent-performance.types.js';
import { share, toDelivery } from './cod-health.resolver.js';

/** Staff who see how each agent did: owners and managers. */
const MANAGING_ROLES: readonly StaffRole[] = ['owner', 'manager'];

@Resolver()
export class AgentPerformanceResolver {
  constructor(private readonly agents: AgentPerformanceService) {}

  @Query(() => [ConfirmationAgent], {
    description:
      "Agents' performance (COD-11): for each agent of the Confirmation Desk, staff or app, the " +
      'orders they confirmed and cancelled over a period, their calls that settled nothing, ' +
      'their hours on the desk, and how the orders they confirmed turned out; those who settled ' +
      "most orders first. Customers confirming through their links are no one's work. Owners " +
      'and managers see it, and apps with read_orders. Worked out when asked.',
  })
  @RequireScopes('read_orders')
  async confirmationAgents(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: ConfirmationAgentsArgs,
  ): Promise<ConfirmationAgent[]> {
    if (tenant.actor.kind === 'staff' && !MANAGING_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole("Access denied. Only owners and managers see agents' performance.");
    }
    const result = await this.agents.report(tenant, {
      from: args.from,
      before: args.before,
      first: pageSize(args.first),
    });
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return result.value.map((row) =>
      Object.assign(new ConfirmationAgent(), {
        kind: row.agent.kind === 'app' ? ConfirmationAgentKind.APP : ConfirmationAgentKind.STAFF,
        id: toPublicId(row.agent.kind === 'app' ? 'accessToken' : 'user', row.agent.id),
        confirmed: row.confirmed,
        cancelled: row.cancelled,
        confirmationRate: share(row.confirmed, row.confirmed + row.cancelled),
        calls: Object.assign(new ConfirmationAgentCalls(), row.calls),
        activeHours: row.activeHours,
        confirmationsPerHour:
          row.activeHours === 0 ? null : Math.round((row.confirmed / row.activeHours) * 100) / 100,
        delivery: toDelivery(row.delivery, tenant.currency),
      }),
    );
  }
}
