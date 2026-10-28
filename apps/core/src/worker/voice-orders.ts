import {
  SPEECH_LIMITS,
  readVoiceOrder,
  type AiGateway,
  type SpeechToText,
  type VoiceOrderItem,
} from '@hatti/ai';
import { shopProfile, type AiCredits, type StorefrontSite, type TenantContext } from '@hatti/api';
import type { ProductRecord, ProductService, VariantRecord } from '@hatti/catalog/public';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import {
  MessagingEvents,
  VOICE_ORDER_DAY,
  claimVoiceNoteIn,
  keepTranscriptIn,
  recordVoiceOrderIn,
  voiceOrdersOnIn,
  voiceOrdersSinceIn,
  type ConversationMessageReceivedPayload,
  type ConversationsService,
  type VoiceOrderOutcome,
} from '@hatti/messaging/public';

/** How customers say sizes, and how shops name them. */
const SIZES: Readonly<Record<string, string>> = {
  'extra small': 'xs',
  small: 's',
  medium: 'm',
  large: 'l',
  'extra large': 'xl',
};

/** A choice as said, and as a shop names it: "medium" and "m" alike. */
function said(option: string): string[] {
  const plain = option.trim().toLowerCase();
  const size = SIZES[plain];
  return size ? [plain, size] : [plain.replace(/^size\s+/, '')];
}

/**
 * The variant of `product` the customer asked for, by the choices they said: its only one, or
 * the one whose every option value they said; null where they didn't say enough to tell.
 */
export function variantAskedFor(
  product: Pick<ProductRecord, 'variants'>,
  options: readonly string[],
): VariantRecord | null {
  if (product.variants.length === 1) return product.variants[0]!;
  const spoken = new Set(options.flatMap(said));
  const fitting = product.variants.filter((variant) =>
    variant.selectedOptions.every((selected) => spoken.has(selected.value.toLowerCase())),
  );
  return fitting.length === 1 ? fitting[0]! : null;
}

/** What a voice note was read into, as the shop sells it. */
export interface VoiceOrderMatch {
  /** Variants found, how many, and their names for the reply. */
  lines: { variantId: string; quantity: number; name: string }[];
  /** Products found whose size or colour wasn't said: their pages, to choose on. */
  choose: { name: string; url: string }[];
  /** What was asked for that the shop sells none of. */
  missing: string[];
}

/** The reply to a voice note read into what the shop sells, in English and Urdu. */
export function voiceOrderReply(match: VoiceOrderMatch, link: string | null): string {
  const parts: string[] = [];
  if (link) {
    const items = match.lines.map((line) => `${line.quantity} × ${line.name}`).join('\n');
    parts.push(
      `Thank you! We heard your voice note:\n${items}\n\nCheck your cart, give your address and ` +
        `place your order here: ${link}`,
      `شکریہ! ہم نے آپ کا وائس نوٹ سن لیا۔ اپنا کارٹ دیکھیں، پتا دیں اور یہاں آرڈر کریں: ${link}`,
    );
  }
  if (match.choose.length > 0) {
    parts.push(
      'Choose your size or colour here:\n' +
        match.choose.map((product) => `${product.name}: ${product.url}`).join('\n'),
      'اپنا سائز یا رنگ یہاں چنیں۔',
    );
  }
  if (match.missing.length > 0) {
    parts.push(
      `We couldn't find ${match.missing.join(', ')}. We'll answer you here.`,
      'کچھ چیزیں نہیں ملیں: ہم آپ کو یہیں جواب دیں گے۔',
    );
  }
  return parts.join('\n\n');
}

/**
 * Voice-note orders (MSG-11, ADR-871): a customer's WhatsApp voice note to a shop that turned
 * them on is fetched with the number's token, heard by Hatti's own speech-to-text server, and
 * read by the AI into what it orders; the shop's own search finds each thing, and the customer
 * is answered with its checkout holding what was found, their number filled in, and the pages of
 * what needs a size or colour chosen. What was heard is kept on the message for staff to read in
 * the inbox; the audio is never kept. One AI credit a voice note read; none past the shop's day.
 */
export class VoiceOrders {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [MessagingEvents.ConversationMessageReceived];

  constructor(
    private readonly database: Database,
    private readonly products: Pick<ProductService, 'searchIdsOf' | 'recordsOf'>,
    private readonly conversations: Pick<ConversationsService, 'reply' | 'mediaOf'>,
    private readonly speech: Pick<SpeechToText, 'transcribe'>,
    private readonly ai: AiGateway,
    private readonly credits: Pick<AiCredits, 'balanceOf' | 'spend'>,
    private readonly storefronts: StorefrontSite,
  ) {}

  /** What came of the voice note the event names; null where it names none to hear. */
  async handle(event: DomainEvent, now: Date = new Date()): Promise<VoiceOrderOutcome | null> {
    const { shopId } = event;
    const written = event.payload as Partial<ConversationMessageReceivedPayload>;
    if (event.type !== MessagingEvents.ConversationMessageReceived || !written.messageId) {
      return null;
    }
    const messageId = written.messageId;
    const claimed = await this.database.tenant(shopId, async (tx) => {
      if (!(await voiceOrdersOnIn(tx, shopId))) return null;
      // Past the day's voice notes, they wait for staff, unheard.
      if ((await voiceOrdersSinceIn(tx, shopId, now)) >= VOICE_ORDER_DAY.perDay) return null;
      return claimVoiceNoteIn(tx, shopId, messageId);
    });
    if (!claimed) return null;
    if ((await this.credits.balanceOf(shopId, now)).left <= 0) return null;
    const record = (outcome: VoiceOrderOutcome, more: Record<string, number> = {}) =>
      this.database
        .tenant(shopId, (tx) =>
          recordVoiceOrderIn(tx, shopId, { messageId, outcome, at: now, ...more }),
        )
        .then(() => outcome);

    const audio = await this.conversations.mediaOf(
      shopId,
      claimed.viaPhoneNumberId,
      claimed.mediaId,
      SPEECH_LIMITS.bytes,
    );
    if (!audio.ok) return record(audio.tooLarge ? 'too_long' : 'not_heard');
    const heard = await this.speech.transcribe(audio.data, audio.mediaType, 'ur');
    if (!heard.ok) return record(heard.reason === 'too_long' ? 'too_long' : 'not_heard');
    if (!heard.text) return record('not_heard');
    const shopName = await this.database.tenant(shopId, async (tx) => {
      await keepTranscriptIn(tx, shopId, messageId, heard.text);
      return (await shopProfile(tx, shopId)).name;
    });

    const read = await readVoiceOrder(this.ai, { transcript: heard.text, shopName });
    const tokens = {
      inputTokens: read.usage?.inputTokens ?? 0,
      outputTokens: read.usage?.outputTokens ?? 0,
    };
    if (!read.ok) return record('failed', tokens);
    await this.credits.spend(shopId, 'voice_order', now);
    if (!read.value.order) return record('no_order', tokens);

    const { items } = read.value;
    const { match, handle } = await this.database.tenant(shopId, async (tx) => ({
      match: await this.#matched(tx, shopId, items),
      handle: (await shopProfile(tx, shopId)).handle,
    }));
    const counts = { ...tokens, items: items.length, matched: match.lines.length };
    if (match.lines.length === 0 && match.choose.length === 0) return record('unmatched', counts);
    const store = this.storefronts.url(handle).replace(/\/+$/, '');
    const link =
      match.lines.length > 0
        ? `${store}/cart/` +
          match.lines.map((line) => `${line.variantId}:${line.quantity}`).join(',') +
          `?${new URLSearchParams({ 'checkout[phone]': claimed.customerPhone })}`
        : null;
    const tenant: TenantContext = {
      shopId,
      currency: 'PKR',
      scopes: new Set(),
      actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    };
    const reply = voiceOrderReply(
      { ...match, choose: match.choose.map((each) => ({ ...each, url: `${store}${each.url}` })) },
      link,
    );
    await this.conversations.reply(tenant, claimed.conversationId, reply, now, { ai: true });
    return record('answered', counts);
  }

  /** Each thing asked for, found by the shop's own search, and its variant by what was said. */
  async #matched(
    tx: Parameters<ProductService['searchIdsOf']>[0],
    shopId: string,
    items: readonly VoiceOrderItem[],
  ): Promise<VoiceOrderMatch> {
    const match: VoiceOrderMatch = { lines: [], choose: [], missing: [] };
    for (const item of items) {
      const [found] = await this.products.searchIdsOf(tx, shopId, item.search, 1);
      const [product] = found ? await this.products.recordsOf(tx, shopId, [found]) : [];
      if (!product) {
        match.missing.push(item.search);
        continue;
      }
      const variant = variantAskedFor(product, item.options);
      if (!variant) {
        match.choose.push({ name: product.title, url: `/products/${product.handle}` });
        continue;
      }
      match.lines.push({
        variantId: variant.id,
        quantity: item.quantity,
        name: product.variants.length > 1 ? `${product.title} (${variant.title})` : product.title,
      });
    }
    return match;
  }
}
