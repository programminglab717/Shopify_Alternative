import {
  CurrentTenant,
  Money,
  PageInfo,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { money } from '@hatti/money';
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
  registerEnumType,
} from '@nestjs/graphql';
import {
  POS_LIMITS,
  PosService,
  type PosRegisterRecord,
  type PosSaleRecord,
  type PosSessionReport,
  type PosTenderMethod,
} from '../pos.service.js';
import { uuidOf } from './mappers.js';

export enum PosTenderMethodValue {
  CASH = 'CASH',
  CARD = 'CARD',
  BANK_TRANSFER = 'BANK_TRANSFER',
  WALLET = 'WALLET',
}

registerEnumType(PosTenderMethodValue, {
  name: 'PosTenderMethod',
  description: 'How a sale at the till was paid, or paid back.',
  valuesMap: {
    CASH: { description: 'Cash in the drawer.' },
    CARD: { description: "A card on the shop's own terminal." },
    BANK_TRANSFER: { description: "A bank transfer or Raast to the shop's account." },
    WALLET: { description: "JazzCash or Easypaisa to the shop's account." },
  },
});

const methodOf = (value: PosTenderMethodValue) => value.toLowerCase() as PosTenderMethod;
const valueOf = (method: PosTenderMethod) => method.toUpperCase() as PosTenderMethodValue;
const pkr = (amount: bigint) => Money.from(money(amount, 'PKR'));

@ObjectType({
  description:
    "A register at the shop's till (POS-01, ADR-872): it sells from one of the shop's " +
    'locations, in cash sessions staff open and close.',
})
export class PosRegister {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => ID, { description: 'The location whose shelf its sales come off.' })
  locationId!: string;

  @Field(() => ID, { nullable: true, description: 'Its session open now; null when none is.' })
  openSessionId!: string | null;
}

@ObjectType({ description: 'A variant as the till sells it, with what its shelf has.' })
export class PosCatalogItem {
  @Field(() => ID)
  variantId!: string;

  @Field(() => ID)
  productId!: string;

  @Field()
  productTitle!: string;

  @Field()
  variantTitle!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => String, { nullable: true, description: 'What a scanner reads off its label.' })
  barcode!: string | null;

  @Field(() => Money)
  price!: Money;

  @Field(() => Int, {
    nullable: true,
    description: "Available at the register's location; null for stock not tracked.",
  })
  available!: number | null;
}

@ObjectType()
export class PosTenderTotal {
  @Field(() => PosTenderMethodValue)
  method!: PosTenderMethodValue;

  @Field(() => Money, { description: 'Taken by it, less what was paid back and change given.' })
  amount!: Money;
}

@ObjectType({
  description:
    "A register's cash session, as its Z report gives it: what it sold, how it was paid, and " +
    'what its drawer should hold.',
})
export class PosSession {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  registerId!: string;

  @Field(() => GraphQLISODateTime)
  openedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  closedAt!: Date | null;

  @Field(() => Money, { description: 'Cash in the drawer as it opened.' })
  openingFloat!: Money;

  @Field(() => Int)
  salesCount!: number;

  @Field(() => Money, { description: 'What its sales came to before discounts.' })
  gross!: Money;

  @Field(() => Money)
  discounts!: Money;

  @Field(() => Money, { description: 'The sales tax included in its prices.' })
  tax!: Money;

  @Field(() => Int)
  returnsCount!: number;

  @Field(() => Money, { description: 'Paid back for units brought back.' })
  returned!: Money;

  @Field(() => [PosTenderTotal])
  tenders!: PosTenderTotal[];

  @Field(() => Money)
  cashIn!: Money;

  @Field(() => Money)
  cashOut!: Money;

  @Field(() => Money, { description: 'What the drawer should hold now, or held as it closed.' })
  expectedCash!: Money;

  @Field(() => Money, { nullable: true, description: 'What was counted as it closed.' })
  countedCash!: Money | null;

  @Field(() => Money, {
    nullable: true,
    description: 'Counted less expected: below zero short, above zero over; null while open.',
  })
  difference!: Money | null;

  @Field(() => String, { nullable: true })
  closingNote!: string | null;
}

@ObjectType()
export class PosSaleLine {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  variantId!: string;

  @Field()
  title!: string;

  @Field()
  variantTitle!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Money)
  unitPrice!: Money;

  @Field(() => Money, { description: "Its share of the sale's discount." })
  discount!: Money;

  @Field(() => Money, { description: 'What was paid for it.' })
  total!: Money;

  @Field(() => Money, { description: 'The sales tax included in it.' })
  tax!: Money;

  @Field(() => Int, { description: 'Units brought back.' })
  returnedQuantity!: number;
}

@ObjectType()
export class PosTender {
  @Field(() => PosTenderMethodValue)
  method!: PosTenderMethodValue;

  @Field(() => Money)
  amount!: Money;

  @Field(() => String, { nullable: true, description: "The terminal's or transfer's reference." })
  reference!: string | null;
}

@ObjectType({ description: 'A sale at the till: its lines, and how it was paid.' })
export class PosSale {
  @Field(() => ID)
  id!: string;

  @Field({ description: '"#P12", the shop’s own run of till receipts.' })
  name!: string;

  @Field(() => ID, { description: "The till's own ID for it." })
  clientId!: string;

  @Field(() => ID)
  registerId!: string;

  @Field(() => ID)
  sessionId!: string;

  @Field(() => ID)
  locationId!: string;

  @Field(() => ID, { nullable: true, description: 'Its customer; null for a walk-in.' })
  customerId!: string | null;

  @Field(() => Money)
  subtotal!: Money;

  @Field(() => Money)
  discount!: Money;

  @Field(() => Money, { description: 'The sales tax included in its prices.' })
  tax!: Money;

  @Field(() => Money)
  total!: Money;

  @Field(() => Money, { description: 'Cash handed back.' })
  changeGiven!: Money;

  @Field(() => Money, { description: 'Paid back for units brought back.' })
  returned!: Money;

  @Field()
  note!: string;

  @Field(() => GraphQLISODateTime, { description: 'When the till sold it.' })
  soldAt!: Date;

  @Field(() => [PosSaleLine])
  lines!: PosSaleLine[];

  @Field(() => [PosTender])
  tenders!: PosTender[];
}

@ObjectType()
export class PosSaleConnection {
  @Field(() => [PosSale], { description: 'The latest first.' })
  nodes!: PosSale[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@InputType()
export class PosRegisterInput {
  @Field(() => ID, { nullable: true, description: 'The register to change; none for a new one.' })
  id?: string | null;

  @Field()
  name!: string;

  @Field(() => ID)
  locationId!: string;
}

@InputType()
export class PosSaleLineInput {
  @Field(() => ID)
  variantId!: string;

  @Field(() => Int)
  quantity!: number;

  @Field(() => String, {
    nullable: true,
    description: "Replaces the variant's price, in major units: one agreed at the counter.",
  })
  price?: string | null;
}

@InputType()
export class PosTenderInput {
  @Field(() => PosTenderMethodValue)
  method!: PosTenderMethodValue;

  @Field({ description: 'In major units. Cash tendered may be more than the total: the change.' })
  amount!: string;

  @Field(() => String, { nullable: true })
  reference?: string | null;
}

@InputType()
export class PosSaleInput {
  @Field(() => ID, {
    description:
      "The till's own ID for the sale, a UUID it makes: a sale sent again with it, as an " +
      'offline till does, is the sale kept the first time.',
  })
  clientId!: string;

  @Field(() => ID)
  sessionId!: string;

  @Field(() => [PosSaleLineInput])
  lines!: PosSaleLineInput[];

  @Field(() => String, { nullable: true, description: 'Off the whole sale, in major units.' })
  discount?: string | null;

  @Field(() => String, {
    nullable: true,
    description: "The customer's mobile number, to link the sale to them; none for a walk-in.",
  })
  customerPhone?: string | null;

  @Field(() => String, { nullable: true })
  customerName?: string | null;

  @Field(() => [PosTenderInput])
  tenders!: PosTenderInput[];

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
    description: `When the till sold it, for a sale sent later: within ${POS_LIMITS.offlineDays} days.`,
  })
  soldAt?: Date | null;
}

@InputType()
export class PosReturnLineInput {
  @Field(() => ID)
  lineId!: string;

  @Field(() => Int)
  quantity!: number;
}

@InputType()
export class PosReturnInput {
  @Field(() => ID)
  saleId!: string;

  @Field(() => ID, { description: 'The session whose drawer pays it back.' })
  sessionId!: string;

  @Field(() => [PosReturnLineInput])
  lines!: PosReturnLineInput[];

  @Field({ description: 'Back on the shelf; false for goods written off.' })
  restock!: boolean;

  @Field(() => PosTenderMethodValue)
  method!: PosTenderMethodValue;

  @Field(() => String, { nullable: true })
  reason?: string | null;
}

@ObjectType()
export class PosRegisterPayload {
  @Field(() => PosRegister, { nullable: true })
  register!: PosRegister | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PosSessionPayload {
  @Field(() => PosSession, { nullable: true })
  session!: PosSession | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PosSalePayload {
  @Field(() => PosSale, { nullable: true })
  sale!: PosSale | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class PosRegisterArchivePayload {
  @Field(() => ID, { nullable: true })
  archivedRegisterId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

function toRegister(record: PosRegisterRecord): PosRegister {
  return Object.assign(new PosRegister(), {
    id: toPublicId('posRegister', record.id),
    name: record.name,
    locationId: toPublicId('location', record.locationId),
    openSessionId: record.openSessionId && toPublicId('posSession', record.openSessionId),
  });
}

function toSession(report: PosSessionReport): PosSession {
  const { session } = report;
  return Object.assign(new PosSession(), {
    id: toPublicId('posSession', session.id),
    registerId: toPublicId('posRegister', session.registerId),
    openedAt: session.openedAt,
    closedAt: session.closedAt,
    openingFloat: pkr(session.openingFloat),
    salesCount: report.sales,
    gross: pkr(report.gross),
    discounts: pkr(report.discounts),
    tax: pkr(report.tax),
    returnsCount: report.returns,
    returned: pkr(report.returned),
    tenders: report.tenders.map((tender) =>
      Object.assign(new PosTenderTotal(), {
        method: valueOf(tender.method),
        amount: pkr(tender.amount),
      }),
    ),
    cashIn: pkr(report.cashIn),
    cashOut: pkr(report.cashOut),
    expectedCash: pkr(report.expectedCash),
    countedCash: session.countedCash === null ? null : pkr(session.countedCash),
    difference: report.difference === null ? null : pkr(report.difference),
    closingNote: session.closingNote,
  });
}

function toSale(record: PosSaleRecord): PosSale {
  return Object.assign(new PosSale(), {
    id: toPublicId('posSale', record.id),
    name: `#P${record.number}`,
    clientId: record.clientId,
    registerId: toPublicId('posRegister', record.registerId),
    sessionId: toPublicId('posSession', record.sessionId),
    locationId: toPublicId('location', record.locationId),
    customerId: record.customerId && toPublicId('customer', record.customerId),
    subtotal: pkr(record.subtotal),
    discount: pkr(record.discount),
    tax: pkr(record.tax),
    total: pkr(record.total),
    changeGiven: pkr(record.changeGiven),
    returned: pkr(record.returned),
    note: record.note,
    soldAt: record.soldAt,
    lines: record.lines.map((line) =>
      Object.assign(new PosSaleLine(), {
        id: toPublicId('posSaleLine', line.id),
        variantId: toPublicId('variant', line.variantId),
        title: line.title,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        unitPrice: pkr(line.unitPrice),
        discount: pkr(line.discount),
        total: pkr(line.total),
        tax: pkr(line.tax),
        returnedQuantity: line.returned,
      }),
    ),
    tenders: record.tenders.map((tender) =>
      Object.assign(new PosTender(), {
        method: valueOf(tender.method),
        amount: pkr(tender.amount),
        reference: tender.reference,
      }),
    ),
  });
}

/** An ID of none, which the service finds nothing by. */
const NONE = '00000000-0000-0000-0000-000000000000';
const idOf = (kind: Parameters<typeof tryFromPublicId>[1], id: string) =>
  tryFromPublicId(id, kind) ?? NONE;

/** The shop's tills (POS-01, ADR-872): registers, cash sessions, sales and returns. */
@Resolver()
export class PosResolver {
  constructor(private readonly pos: PosService) {}

  @Query(() => [PosRegister], { description: "The shop's registers, by name." })
  @RequireScopes('read_orders')
  async posRegisters(@CurrentTenant() tenant: TenantContext): Promise<PosRegister[]> {
    return (await this.pos.registers(tenant)).map(toRegister);
  }

  @Query(() => [PosCatalogItem], {
    nullable: true,
    description:
      `What the register sells, at most ${POS_LIMITS.catalog} variants of the shop's active ` +
      "products, with its location's stock: for the till to find by title, SKU or barcode, " +
      'and to keep for when it is offline. Null for no such register.',
  })
  @RequireScopes('read_orders')
  async posCatalog(
    @CurrentTenant() tenant: TenantContext,
    @Args('registerId', { type: () => ID }) registerId: string,
  ): Promise<PosCatalogItem[] | null> {
    const items = await this.pos.catalog(tenant, idOf('posRegister', registerId));
    return (
      items?.map((item) =>
        Object.assign(new PosCatalogItem(), {
          variantId: toPublicId('variant', item.variantId),
          productId: toPublicId('product', item.productId),
          productTitle: item.productTitle,
          variantTitle: item.variantTitle,
          sku: item.sku,
          barcode: item.barcode,
          price: pkr(item.price),
          available: item.available,
        }),
      ) ?? null
    );
  }

  @Query(() => PosSession, { nullable: true, description: 'A cash session, as its Z report.' })
  @RequireScopes('read_orders')
  async posSession(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PosSession | null> {
    const report = await this.pos.report(tenant, idOf('posSession', id));
    return report && toSession(report);
  }

  @Query(() => PosSale, { nullable: true })
  @RequireScopes('read_orders')
  async posSale(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PosSale | null> {
    const sale = await this.pos.sale(tenant, idOf('posSale', id));
    return sale && toSale(sale);
  }

  @Query(() => PosSaleConnection, {
    description: "The shop's till sales, the latest first: a session's, or a customer's.",
  })
  @RequireScopes('read_orders')
  async posSales(
    @CurrentTenant() tenant: TenantContext,
    @Args('first', { type: () => Int, defaultValue: 25 }) first: number,
    @Args('before', { type: () => String, nullable: true }) before?: string | null,
    @Args('sessionId', { type: () => ID, nullable: true }) sessionId?: string | null,
    @Args('customerId', { type: () => ID, nullable: true }) customerId?: string | null,
  ): Promise<PosSaleConnection> {
    const page = await this.pos.sales(tenant, {
      first: Math.min(Math.max(first, 1), 100),
      before: before ? idOf('posSale', before) : null,
      sessionId: sessionId ? uuidOf('posSession', sessionId) : null,
      customerId: customerId ? uuidOf('customer', customerId) : null,
    });
    const nodes = page.items.map(toSale);
    return Object.assign(new PosSaleConnection(), {
      nodes,
      pageInfo: {
        hasNextPage: page.hasNextPage,
        hasPreviousPage: false,
        startCursor: nodes[0]?.id ?? null,
        endCursor: nodes.at(-1)?.id ?? null,
      },
    });
  }

  @Mutation(() => PosRegisterPayload, {
    description: 'Adds a register, or renames one or moves it to another location.',
  })
  @RequireScopes('write_settings')
  async posRegisterSave(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PosRegisterInput,
  ): Promise<PosRegisterPayload> {
    const result = await this.pos.saveRegister(tenant, {
      id: input.id ? idOf('posRegister', input.id) : null,
      name: input.name,
      locationId: idOf('location', input.locationId),
    });
    return Object.assign(new PosRegisterPayload(), {
      register: result.ok ? toRegister(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PosRegisterArchivePayload, {
    description: 'Takes a register away once its session is closed; its sales stay.',
  })
  @RequireScopes('write_settings')
  async posRegisterArchive(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<PosRegisterArchivePayload> {
    const result = await this.pos.archiveRegister(tenant, idOf('posRegister', id));
    return Object.assign(new PosRegisterArchivePayload(), {
      archivedRegisterId: result.ok ? id : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PosSessionPayload, {
    description: 'Opens a cash session on the register, with its float in the drawer.',
  })
  @RequireScopes('write_orders')
  async posSessionOpen(
    @CurrentTenant() tenant: TenantContext,
    @Args('registerId', { type: () => ID }) registerId: string,
    @Args('openingFloat') openingFloat: string,
  ): Promise<PosSessionPayload> {
    const opened = await this.pos.openSession(
      tenant,
      idOf('posRegister', registerId),
      openingFloat,
    );
    const report = opened.ok ? await this.pos.report(tenant, opened.value.id) : null;
    return Object.assign(new PosSessionPayload(), {
      session: report && toSession(report),
      userErrors: opened.ok ? [] : UserError.list(opened.errors),
    });
  }

  @Mutation(() => PosSessionPayload, {
    description: 'Cash put into the drawer, or taken out, with why.',
  })
  @RequireScopes('write_orders')
  async posCashMove(
    @CurrentTenant() tenant: TenantContext,
    @Args('sessionId', { type: () => ID }) sessionId: string,
    @Args('out') out: boolean,
    @Args('amount') amount: string,
    @Args('note') note: string,
  ): Promise<PosSessionPayload> {
    const result = await this.pos.moveCash(tenant, {
      sessionId: idOf('posSession', sessionId),
      kind: out ? 'out' : 'in',
      amount,
      note,
    });
    return Object.assign(new PosSessionPayload(), {
      session: result.ok ? toSession(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PosSessionPayload, {
    description:
      'Closes the session with the cash counted in its drawer: its Z report, saying whether ' +
      'the drawer is short or over.',
  })
  @RequireScopes('write_orders')
  async posSessionClose(
    @CurrentTenant() tenant: TenantContext,
    @Args('sessionId', { type: () => ID }) sessionId: string,
    @Args('countedCash') countedCash: string,
    @Args('note', { type: () => String, nullable: true }) note?: string | null,
  ): Promise<PosSessionPayload> {
    const result = await this.pos.closeSession(tenant, {
      sessionId: idOf('posSession', sessionId),
      countedCash,
      note: note ?? null,
    });
    return Object.assign(new PosSessionPayload(), {
      session: result.ok ? toSession(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PosSalePayload, {
    description:
      "A sale at the till: its units off the register's location's shelf, paid as tendered, " +
      'change given from cash. A sale whose clientId was kept already is that sale.',
  })
  @RequireScopes('write_orders')
  async posSaleCreate(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PosSaleInput,
  ): Promise<PosSalePayload> {
    const result = await this.pos.sell(tenant, {
      clientId: input.clientId,
      sessionId: idOf('posSession', input.sessionId),
      lines: input.lines.map((line) => ({
        variantId: idOf('variant', line.variantId),
        quantity: line.quantity,
        price: line.price ?? null,
      })),
      discount: input.discount ?? null,
      customerPhone: input.customerPhone ?? null,
      customerName: input.customerName ?? null,
      tenders: input.tenders.map((tender) => ({
        method: methodOf(tender.method),
        amount: tender.amount,
        reference: tender.reference ?? null,
      })),
      note: input.note ?? null,
      soldAt: input.soldAt ?? null,
    });
    return Object.assign(new PosSalePayload(), {
      sale: result.ok ? toSale(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }

  @Mutation(() => PosSalePayload, {
    description:
      "Units of a till sale brought back: paid back from the session's drawer or as asked, " +
      'and back on the shelf unless written off.',
  })
  @RequireScopes('write_orders')
  async posSaleReturn(
    @CurrentTenant() tenant: TenantContext,
    @Args('input') input: PosReturnInput,
  ): Promise<PosSalePayload> {
    const result = await this.pos.returnSale(tenant, {
      saleId: idOf('posSale', input.saleId),
      sessionId: idOf('posSession', input.sessionId),
      lines: input.lines.map((line) => ({
        lineId: idOf('posSaleLine', line.lineId),
        quantity: line.quantity,
      })),
      restock: input.restock,
      method: methodOf(input.method),
      reason: input.reason ?? null,
    });
    return Object.assign(new PosSalePayload(), {
      sale: result.ok ? toSale(result.value) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
