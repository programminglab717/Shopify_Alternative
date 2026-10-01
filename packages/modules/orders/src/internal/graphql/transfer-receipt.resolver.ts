import { CurrentTenant, Loaders, RequestLoaders, type TenantContext } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { TransferReceiptService, type TransferReceiptRecord } from '../transfer-receipt.service.js';
import { Order, OrderPaymentMethod } from './order.types.js';
import { TransferReceipt } from './transfer-receipt.types.js';

/** Customers' receipts for their transfers, on their orders (ADR-080). */
@Resolver(() => Order)
export class TransferReceiptResolver {
  constructor(private readonly receipts: TransferReceiptService) {}

  @ResolveField(() => [TransferReceipt], {
    description:
      'Receipts its customer sent for its bank transfer through its page, oldest first; none ' +
      'for other orders.',
  })
  async transferReceipts(
    @CurrentTenant() tenant: TenantContext,
    @Loaders() loaders: RequestLoaders,
    @Parent() order: Order,
  ): Promise<TransferReceipt[]> {
    if (order.paymentMethod !== OrderPaymentMethod.BANK_TRANSFER) return [];
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
