import type { Tx } from '@hatti/db';
import { ownerEmailIn } from '@hatti/identity/public';
import {
  settingsIn,
  type MessageKind,
  type MessagesService,
  type MessageVariables,
} from '@hatti/messaging/public';

/** One of Hatti's notices to a shop: its kind, what it says, and its key against sending it twice. */
export interface ShopNotice {
  kind: MessageKind;
  dedupeKey: string;
  variables: MessageVariables;
}

/**
 * Queues one of Hatti's notices to a shop in its transaction `tx` (ADR-169): on WhatsApp at the
 * shop's alerts number, in the shop's language, where it gives one; and by email to its owner, at
 * the address their account proved, in their own language (ADR-195), which identity gives for the
 * shop alone. Each once, by its key, and at Hatti's cost: never the shop's credit.
 */
export async function tellShop(
  tx: Tx,
  messages: MessagesService,
  shopId: string,
  notice: ShopNotice,
): Promise<void> {
  const { alertsPhone } = await settingsIn(tx, shopId);
  if (alertsPhone) {
    await messages.queueIn(tx, shopId, {
      kind: notice.kind,
      recipient: alertsPhone,
      dedupeKey: notice.dedupeKey,
      variables: notice.variables,
      channel: 'whatsapp',
    });
  }
  // Through identity's function for the shop of the transaction, never its tables (ADR-193).
  const owner = await ownerEmailIn(tx, shopId);
  if (owner) {
    await messages.queueIn(tx, shopId, {
      kind: notice.kind,
      recipient: owner.email,
      language: owner.language,
      dedupeKey: `${notice.dedupeKey}:email`,
      variables: notice.variables,
      channel: 'email',
    });
  }
}
