import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Order } from './order.types.js';

export enum OrderDocumentKind {
  PACKING_SLIP = 'PACKING_SLIP',
  INVOICE = 'INVOICE',
  CREDIT_NOTE = 'CREDIT_NOTE',
}

registerEnumType(OrderDocumentKind, {
  name: 'OrderDocumentKind',
  description: 'What to print for an order.',
  valuesMap: {
    PACKING_SLIP: {
      description:
        'Goes in the parcel: the items left to ship, where it goes and the cash to collect, ' +
        'without prices. Warns across the top when the order is cancelled, not confirmed yet ' +
        'or already shipped.',
    },
    INVOICE: {
      description:
        'What was bought at what price, what was paid and what is left to pay. Printed, it is ' +
        "issued: numbered in the shop's series the first time (ADR-495).",
    },
    CREDIT_NOTE: {
      description:
        'A page for each credit note of the orders: money refunded once their invoices were ' +
        'issued, numbered in a series of their own (ADR-496).',
    },
  },
});

/** Shared with every module that prints, from the API package. */
export { DocumentLanguage, PaperSize } from '@hatti/api';

@ObjectType({ description: 'Packing slips or invoices, as one HTML page to print or save.' })
export class OrderDocument {
  @Field({
    description:
      'A complete HTML page with each order on a page of its own, set up for the paper. It ' +
      'loads Inter and Noto Nastaliq Urdu from Google Fonts: print once `document.fonts.ready` ' +
      'resolves. It runs no scripts.',
  })
  html!: string;

  @Field({ description: 'For the browser tab, e.g. "Packing slip #1001".' })
  title!: string;

  @Field({ description: 'A name to save it as, e.g. "packing-slips-1001-1037.html".' })
  fileName!: string;

  @Field(() => [Order], {
    description:
      'The orders in it, in the order asked for. IDs that are no order of the shop are left out.',
  })
  orders!: Order[];
}
