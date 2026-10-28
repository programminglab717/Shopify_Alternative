import {
  CurrentTenant,
  Loaders,
  Money,
  RequestLoaders,
  RequireScopes,
  UserError,
  type TenantContext,
} from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import { Args, ID, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { ReceiptReadingService, type ReceiptReadingView } from '../receipt-readings.js';
import { orderName } from '../rules.js';
import { TransferReceiptService, type TransferReceiptRecord } from '../transfer-receipt.service.js';
import { uuidOf } from './mappers.js';
import { Order } from './order.types.js';
import {
  RefundReceipt,
  TransferReceipt,
  TransferReceiptAccountCheck,
  TransferReceiptAmountCheck,
  TransferReceiptReadOutcome,
  TransferReceiptReading,
  TransferReceiptReadPayload,
} from './transfer-receipt.types.js';

/** A reading as the Admin API gives it. */
function toReading(view: ReceiptReadingView, currency: CurrencyCode): TransferReceiptReading {
  const outcome = view.outcome.toUpperCase() as TransferReceiptReadOutcome;
  if (view.outcome !== 'read') {
    return Object.assign(new TransferReceiptReading(), {
      outcome,
      readAt: view.readAt,
      amount: null,
      paidOn: null,
      reference: null,
      senderName: null,
      senderBank: null,
      recipientName: null,
      recipientAccount: null,
      owed: null,
      amountCheck: null,
      accountCheck: null,
      sameReferenceOrders: [],
      beforeOrder: false,
    });
  }
  return Object.assign(new TransferReceiptReading(), {
    outcome,
    readAt: view.readAt,
    amount: view.amount === null ? null : Money.from(money(view.amount, currency)),
    paidOn: view.paidOn,
    reference: view.reference,
    senderName: view.senderName,
    senderBank: view.senderBank,
    recipientName: view.recipientName,
    recipientAccount: view.recipientAccount,
    owed: Money.from(money(view.owed, currency)),
    amountCheck: view.amountCheck.toUpperCase() as TransferReceiptAmountCheck,
    accountCheck: view.accountCheck.toUpperCase() as TransferReceiptAccountCheck,
    sameReferenceOrders: view.sameReferenceOrders.map(orderName),
    beforeOrder: view.beforeOrder,
  });
}

/** Customers' receipts for their transfers, on their orders (ADR-080), advances' too (ADR-083). */
@Resolver(() => Order)
export class TransferReceiptResolver {
  constructor(private readonly receipts: TransferReceiptService) {}

  @ResolveField(() => [TransferReceipt], {
    description:
      'Receipts its customer sent through its page for its bank transfer, or for the advance it ' +
      'asks for, oldest first; none for other orders.',
  })
  async transferReceipts(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() order: Order,
  ): Promise<TransferReceipt[]> {
    const loader = loaders.get<string, TransferReceiptRecord[]>('orders.transferReceipts', (ids) =>
      this.receipts.receiptsOf(tenant, ids),
    );
    const records = (await loader.load(order.uuid)) ?? [];
    return records.map((record, index) =>
      Object.assign(new TransferReceipt(), {
        id: toPublicId('transferReceipt', record.id),
        mimeType: record.contentType,
        fileSize: record.size,
        url: this.receipts.urlOf(record, order.number, index + 1),
        createdAt: record.createdAt,
        uuid: record.id,
      }),
    );
  }
}

/** Receipts read by the AI (PAY-08, ADR-845): what each says, and what Hatti makes of it. */
@Resolver(() => TransferReceipt)
export class TransferReceiptReadingResolver {
  constructor(private readonly readings: ReceiptReadingService) {}

  @ResolveField(() => Boolean, {
    description: 'Whether it may be read with the AI here: once the AI is set up.',
  })
  readable(): boolean {
    return this.readings.available;
  }

  @ResolveField(() => TransferReceiptReading, {
    nullable: true,
    description: 'What it says, as the AI read it; null until it is read.',
  })
  async reading(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() receipt: TransferReceipt,
  ): Promise<TransferReceiptReading | null> {
    const loader = loaders.get<string, ReceiptReadingView | null>('orders.receiptReadings', (ids) =>
      this.readings.readingsOf(tenant, ids),
    );
    const view = await loader.load(receipt.uuid);
    return view ? toReading(view, tenant.currency) : null;
  }

  @Mutation(() => TransferReceiptReadPayload, {
    description:
      "Reads a customer's receipt for their transfer with the AI (PAY-08, ADR-845): what it " +
      'says, how much was sent, when, its reference, from whom and to whom, checked against what ' +
      'its order waits for, the account its customer was told and the references of the ' +
      "shop's other receipts. The AI sees the receipt alone. It never marks the order paid: " +
      'that is for staff to confirm. Spends an AI credit; a receipt read once is not read again.',
  })
  @RequireScopes('write_orders')
  async transferReceiptRead(
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<TransferReceiptReadPayload> {
    const result = await this.readings.read(tenant, uuidOf('transferReceipt', id));
    return Object.assign(new TransferReceiptReadPayload(), {
      reading: result.ok ? toReading(result.value, tenant.currency) : null,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}

/** Refunds' receipts, which staff kept of the money they sent back by hand (ADR-242). */
@Resolver(() => RefundReceipt)
export class RefundReceiptResolver {
  constructor(private readonly receipts: TransferReceiptService) {}

  @ResolveField(() => String, {
    description:
      'Where it is shown, for an hour from when it was asked for, named for its order and the ' +
      'refund\'s place among its refunds: "Refund receipt #1023-1.jpg".',
  })
  url(@Parent() receipt: RefundReceipt): string {
    return this.receipts.refundReceiptUrlOf(receipt.record, receipt.orderNumber, receipt.position);
  }
}
