import { CurrentTenant, RequireScopes, badUserInput, type TenantContext } from '@hatti/api';
import type { Language, Paper } from '@hatti/documents';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { OrderDocumentService } from '../document.service.js';
import type { DocumentKindValue } from '../documents.js';
import { DocumentLanguage, OrderDocument, OrderDocumentKind, PaperSize } from './document.types.js';
import { toOrder, uuidOf } from './mappers.js';

@Resolver()
export class OrderDocumentResolver {
  constructor(private readonly documents: OrderDocumentService) {}

  @Query(() => OrderDocument, {
    description:
      'Packing slips or invoices for up to 250 orders, to print from the browser: one page per ' +
      "order, on A4 or thermal paper, in English and Urdu by default. Customers' numbers show " +
      'as the caller sees them elsewhere, masked for most staff.',
  })
  @RequireScopes('read_orders')
  async orderDocument(
    @CurrentTenant() tenant: TenantContext,
    @Args('ids', { type: () => [ID] }) ids: string[],
    @Args('kind', { type: () => OrderDocumentKind }) kind: OrderDocumentKind,
    @Args('paper', { type: () => PaperSize, defaultValue: PaperSize.A4 }) paper: PaperSize,
    @Args('language', { type: () => DocumentLanguage, defaultValue: DocumentLanguage.BILINGUAL })
    language: DocumentLanguage,
  ): Promise<OrderDocument> {
    const result = await this.documents.render(
      tenant,
      ids.map((id) => uuidOf('order', id)),
      {
        kind: kind.toLowerCase() as DocumentKindValue,
        paper: paper.toLowerCase() as Paper,
        language: language.toLowerCase() as Language,
      },
    );
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return Object.assign(new OrderDocument(), {
      html: result.value.html,
      title: result.value.title,
      fileName: result.value.fileName,
      orders: result.value.orders.map((order) => toOrder(order, tenant)),
    });
  }
}
