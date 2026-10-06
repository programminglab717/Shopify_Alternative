import { CurrentTenant, Loaders, RequestLoaders, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { TransferReceiptService, type TransferReceiptRecord } from '../transfer-receipt.service.js';
import { Order } from './order.types.js';
import { RefundReceipt, TransferReceipt } from './transfer-receipt.types.js';

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
      }),
    );
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
