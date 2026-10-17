import {
  CurrentTenant,
  Money,
  RequireScopes,
  badUserInput,
  deniedToRole,
  shopProfile,
  type StaffRole,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { toPublicId } from '@hatti/ids';
import { CodRemittanceService } from '@hatti/logistics/public';
import { money } from '@hatti/money';
import { GatewayAccountService, PaymentSettlementService } from '@hatti/payments/public';
import {
  Args,
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';

// What gateways and couriers paid the shop over a period, less their fees and the tax they
// withheld (ANL-09, TAX-03): their statements as the shop imported them, by who paid and by month
// in the shop's time zone, and each statement that withheld tax, for the shop's tax credit. See
// ADR-493 in docs/architecture/13-decision-log.md.

export const PAYOUTS_LIMITS = {
  /** Days a report covers at most: a tax year, and a little either side. */
  days: 400,
  /** Statements of each kind a report reads at most; past them, it says it is cut short. */
  statements: 2_000,
};

/** Staff who see what the shop is paid: those who reconcile it (ADR-067, ADR-491). */
const PAYOUT_ROLES: readonly StaffRole[] = ['owner', 'manager', 'accountant'];

export enum PayoutSourceKind {
  GATEWAY = 'gateway',
  COURIER = 'courier',
}

registerEnumType(PayoutSourceKind, {
  name: 'PayoutSourceKind',
  description:
    'Who paid the shop: a payment gateway, for payments online, or a courier, for cash it ' +
    'collected on delivery.',
});

@ArgsType()
class PayoutsReportArgs {
  @Field(() => GraphQLISODateTime, { description: 'Statements imported at or after this.' })
  from!: Date;

  @Field(() => GraphQLISODateTime, {
    description: `Statements imported before this; at most ${PAYOUTS_LIMITS.days} days after from.`,
  })
  before!: Date;
}

@ObjectType({ description: 'What statements came to: paid by customers, deducted, paid over.' })
export class PayoutTotals {
  @Field(() => Int)
  statements!: number;

  @Field(() => Money, {
    description: "What customers paid, or couriers collected, on the statements' lines.",
  })
  gross!: Money;

  @Field(() => Money, { description: "Gateways' fees and couriers' charges." })
  fees!: Money;

  @Field(() => Money, { description: 'The tax withheld from what was paid over.' })
  tax!: Money;

  @Field(() => Money, { description: 'What was paid over to the shop.' })
  net!: Money;
}

@ObjectType({ description: 'One gateway or courier, and what its statements came to.' })
export class PayoutSource extends PayoutTotals {
  @Field(() => PayoutSourceKind)
  kind!: PayoutSourceKind;

  @Field({ description: 'The gateway\'s name, or the courier as staff named it: "Safepay".' })
  name!: string;
}

@ObjectType({ description: "A month in the shop's time zone, and what its statements came to." })
export class PayoutMonth extends PayoutTotals {
  @Field({ description: 'Its year and month: "2026-10".' })
  month!: string;
}

@ObjectType({ description: "A gateway's settlement or a courier's remittance statement." })
export class PayoutStatement {
  @Field(() => ID, { description: 'A PaymentSettlement or a CodRemittance.' })
  id!: string;

  @Field(() => PayoutSourceKind)
  kind!: PayoutSourceKind;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true, description: "The statement's own reference." })
  reference!: string | null;

  @Field(() => GraphQLISODateTime)
  importedAt!: Date;

  @Field(() => Money)
  gross!: Money;

  @Field(() => Money)
  fees!: Money;

  @Field(() => Money)
  tax!: Money;

  @Field(() => Money)
  net!: Money;
}

@ObjectType()
export class PayoutsReport {
  @Field(() => GraphQLISODateTime)
  from!: Date;

  @Field(() => GraphQLISODateTime)
  before!: Date;

  @Field(() => PayoutTotals)
  totals!: PayoutTotals;

  @Field(() => [PayoutSource], { description: 'Who paid, the most paid over first.' })
  sources!: PayoutSource[];

  @Field(() => [PayoutMonth], { description: 'The months with statements, in order.' })
  months!: PayoutMonth[];

  @Field(() => [PayoutStatement], {
    description:
      'The statements that withheld tax, in the order they were imported: the tax credit the ' +
      "shop claims in its return, each with the statement's reference to show for it.",
  })
  withholdings!: PayoutStatement[];

  @Field({
    description: `Whether more than ${PAYOUTS_LIMITS.statements} statements of a kind fell in the period, and the report counts only the first.`,
  })
  truncated!: boolean;
}

/** A statement as the report counts it, whoever sent it. */
interface Counted {
  id: string;
  kind: PayoutSourceKind;
  name: string;
  reference: string | null;
  importedAt: Date;
  gross: bigint;
  fees: bigint;
  tax: bigint;
  net: bigint;
}

interface Tally {
  statements: number;
  gross: bigint;
  fees: bigint;
  tax: bigint;
  net: bigint;
}

const empty = (): Tally => ({ statements: 0, gross: 0n, fees: 0n, tax: 0n, net: 0n });

function add(tally: Tally, statement: Counted): void {
  tally.statements += 1;
  tally.gross += statement.gross;
  tally.fees += statement.fees;
  tally.tax += statement.tax;
  tally.net += statement.net;
}

/** The year and month `at` falls in, in the time zone `timeZone`: "2026-10". */
export function monthOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)!.value;
  return `${part('year')}-${part('month')}`;
}

/** Statements by source, the most paid over first, and by month, in order. */
export function tallyPayouts(
  statements: Counted[],
  timeZone: string,
): {
  totals: Tally;
  sources: (Tally & { kind: PayoutSourceKind; name: string })[];
  months: (Tally & { month: string })[];
} {
  const totals = empty();
  const sources = new Map<string, Tally & { kind: PayoutSourceKind; name: string }>();
  const months = new Map<string, Tally & { month: string }>();
  for (const statement of statements) {
    add(totals, statement);
    // Couriers are named as staff typed them; the same courier in another case is one.
    const key = `${statement.kind}:${statement.name.trim().toLowerCase()}`;
    const source = sources.get(key) ?? { ...empty(), kind: statement.kind, name: statement.name };
    add(source, statement);
    sources.set(key, source);
    const month = monthOf(statement.importedAt, timeZone);
    const entry = months.get(month) ?? { ...empty(), month };
    add(entry, statement);
    months.set(month, entry);
  }
  return {
    totals,
    sources: [...sources.values()].sort(
      (a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0) || a.name.localeCompare(b.name),
    ),
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}

@Resolver(() => PayoutsReport)
export class PayoutsResolver {
  constructor(
    private readonly db: Database,
    private readonly settlements: PaymentSettlementService,
    private readonly accounts: GatewayAccountService,
    private readonly remittances: CodRemittanceService,
  ) {}

  @Query(() => PayoutsReport, {
    description:
      'Payouts and tax withheld (ANL-09, TAX-03): what gateways and couriers paid the shop over ' +
      'a period, as the statements it imported say, less their fees and the tax they withheld; ' +
      "by who paid, by month in the shop's time zone, and each statement that withheld tax. " +
      'Staff need to be an owner, a manager or an accountant.',
  })
  @RequireScopes('read_orders')
  async payoutsReport(
    @CurrentTenant() tenant: TenantContext,
    @Args() args: PayoutsReportArgs,
  ): Promise<PayoutsReport> {
    if (tenant.actor.kind === 'staff' && !PAYOUT_ROLES.includes(tenant.actor.role)) {
      throw deniedToRole(
        'Access denied. Only owners, managers and accountants see what the shop is paid.',
      );
    }
    const days = (args.before.getTime() - args.from.getTime()) / 86_400_000;
    if (!(days > 0) || days > PAYOUTS_LIMITS.days) {
      throw badUserInput(`before must come after from, by ${PAYOUTS_LIMITS.days} days at most`);
    }
    const period = { from: args.from, before: args.before, limit: PAYOUTS_LIMITS.statements };
    const [settled, remitted, accounts, profile] = await Promise.all([
      this.settlements.importedBetween(tenant, period),
      this.remittances.importedBetween(tenant, period),
      this.accounts.list(tenant, { archived: true }),
      this.db.tenant(tenant.shopId, (tx) => shopProfile(tx, tenant.shopId)),
    ]);
    const names = new Map(accounts.map((account) => [account.id, account.gatewayName]));
    const statements: Counted[] = [
      ...settled.map((each) => ({
        id: toPublicId('paymentSettlement', each.id),
        kind: PayoutSourceKind.GATEWAY,
        name: names.get(each.accountId) ?? each.gateway,
        reference: each.reference,
        importedAt: each.createdAt,
        gross: each.gross,
        fees: each.fees,
        tax: each.tax,
        net: each.net,
      })),
      ...remitted.map((each) => ({
        id: toPublicId('codRemittance', each.id),
        kind: PayoutSourceKind.COURIER,
        name: each.courier,
        reference: each.reference,
        importedAt: each.createdAt,
        gross: each.collected,
        fees: each.charges,
        tax: each.tax,
        net: each.paid,
      })),
    ].sort((a, b) => a.importedAt.getTime() - b.importedAt.getTime());
    const tally = tallyPayouts(statements, profile.timezone);
    const amount = (minor: bigint) => Money.from(money(minor, tenant.currency));
    const totalsOf = <T extends PayoutTotals>(target: T, each: Tally): T =>
      Object.assign(target, {
        statements: each.statements,
        gross: amount(each.gross),
        fees: amount(each.fees),
        tax: amount(each.tax),
        net: amount(each.net),
      });
    return Object.assign(new PayoutsReport(), {
      from: args.from,
      before: args.before,
      totals: totalsOf(new PayoutTotals(), tally.totals),
      sources: tally.sources.map((each) =>
        Object.assign(totalsOf(new PayoutSource(), each), { kind: each.kind, name: each.name }),
      ),
      months: tally.months.map((each) =>
        Object.assign(totalsOf(new PayoutMonth(), each), { month: each.month }),
      ),
      withholdings: statements
        .filter((each) => each.tax > 0n)
        .map((each) =>
          Object.assign(new PayoutStatement(), {
            ...each,
            gross: amount(each.gross),
            fees: amount(each.fees),
            tax: amount(each.tax),
            net: amount(each.net),
          }),
        ),
      truncated:
        settled.length >= PAYOUTS_LIMITS.statements || remitted.length >= PAYOUTS_LIMITS.statements,
    });
  }
}
