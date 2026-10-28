import { shopProfile, type StorefrontSite, type TenantContext } from '@hatti/api';
import type { VariantService } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { isUuid } from '@hatti/ids';
import {
  MessagingEvents,
  claimCartIn,
  type ConversationMessageReceivedPayload,
  type ConversationsService,
} from '@hatti/messaging/public';

/** What answers a cart: the shop's checkout holding it, in English and Urdu. */
export function cartReply(link: string, missing: number): string {
  const lines = [
    `Thank you for your order! Check your cart and your address, and place it here: ${link}`,
    `آپ کے آرڈر کا شکریہ! اپنا کارٹ اور پتا دیکھیں اور یہاں آرڈر کریں: ${link}`,
  ];
  if (missing > 0) {
    lines.push(
      missing === 1
        ? "One item isn't sold online any more, so it is left out."
        : `${missing} items aren't sold online any more, so they are left out.`,
    );
  }
  return lines.join('\n\n');
}

/**
 * Carts from shops' WhatsApp catalogues (CH-02, ADR-856): a customer who fills a cart in the
 * catalogue, fed by the shop's catalog feed, and sends it to the shop's number is answered once
 * with a link to the shop's checkout holding what it sells of the cart, their number filled in,
 * for them to give their address and place the order, cash on delivery or paid as the checkout
 * offers. A cart of nothing the shop sells online waits for its staff, in the inbox.
 */
export class WhatsAppCarts {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [MessagingEvents.ConversationMessageReceived];

  constructor(
    private readonly database: Database,
    private readonly variants: Pick<VariantService, 'snapshotsOf'>,
    private readonly conversations: Pick<ConversationsService, 'reply'>,
    private readonly storefronts: StorefrontSite,
  ) {}

  /** The link the cart was answered with; null where the event names no cart to answer. */
  async handle(event: DomainEvent, now: Date = new Date()): Promise<string | null> {
    const { shopId } = event;
    const written = event.payload as Partial<ConversationMessageReceivedPayload>;
    if (event.type !== MessagingEvents.ConversationMessageReceived || !written.messageId) {
      return null;
    }
    const answer = await this.database.tenant(shopId, async (tx) => {
      const cart = await claimCartIn(tx, shopId, written.messageId!);
      if (!cart) return null;
      const ids = cart.items.map((item) => item.variantId).filter(isUuid);
      const snapshots = await this.variants.snapshotsOf(tx, shopId, ids);
      // What the storefront sells: variants of its active products.
      const sold = cart.items.filter(
        (item) => snapshots.get(item.variantId)?.productStatus === 'active',
      );
      if (sold.length === 0) return null;
      const store = this.storefronts.url((await shopProfile(tx, shopId)).handle);
      const link =
        `${store.replace(/\/+$/, '')}/cart/` +
        sold.map((item) => `${item.variantId}:${item.quantity}`).join(',') +
        `?${new URLSearchParams({ 'checkout[phone]': cart.customerPhone })}`;
      return {
        conversationId: cart.conversationId,
        link,
        missing: cart.items.length - sold.length,
      };
    });
    if (!answer) return null;
    const tenant: TenantContext = {
      shopId,
      currency: 'PKR',
      scopes: new Set(),
      actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    };
    const sent = await this.conversations.reply(
      tenant,
      answer.conversationId,
      cartReply(answer.link, answer.missing),
      now,
    );
    return sent.ok ? answer.link : null;
  }
}
