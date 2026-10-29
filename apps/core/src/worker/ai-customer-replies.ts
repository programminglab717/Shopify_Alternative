import { draftSupportReply, type AiGateway } from '@hatti/ai';
import { shopProfile, type AiCredits, type TenantContext } from '@hatti/api';
import { askedProductsIn } from '@hatti/catalog/public';
import type { Database, Tx } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { sellableIn } from '@hatti/inventory/public';
import {
  MessagingEvents,
  type ConversationMessageReceivedPayload,
  type ConversationsService,
  type SupportAgentOutcome,
  type SupportAgentService,
  type SupportAgentTask,
} from '@hatti/messaging/public';
import { formatMoney, isCurrencyCode, money } from '@hatti/money';
import { shopPoliciesOf } from '@hatti/online-store/public';
import { supportFactsIn } from '@hatti/orders/public';

/** The policies the AI may answer from, as the shop wrote them, each so long at most. */
const POLICY_FACTS = [
  'shipping_policy',
  'refund_policy',
  'terms_of_service',
  'contact_information',
] as const;
const POLICY_LIMIT = 2_500;

/** A policy's words without its markup. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();

/** The order numbers a shopper wrote in the web chat, as "#1023" or "order 1023". */
export function orderNumbersIn(history: SupportAgentTask['history']): number[] {
  const numbers = history
    .filter((turn) => turn.from === 'customer')
    .flatMap((turn) => [...turn.text.matchAll(/(?:#|order\s*(?:no\.?|number)?\s*)(\d{3,9})\b/gi)])
    .map((match) => Number(match[1]));
  return [...new Set(numbers)].slice(0, 5);
}

/**
 * Customers answered by the AI (MSG-07, ADR-849): as a customer writes, on WhatsApp or in the web
 * chat, a shop that turned it on has the AI answer from its policies and answers to common
 * questions, the products asked of (ADR-911) and the customer's own orders, while it is the AI's to answer (`SupportAgentService.taskOf`) and the shop has a credit
 * left. On WhatsApp the customer is the number WhatsApp verified, so their latest orders are
 * given; in the web chat the number was typed, so only orders they name by number, placed from it.
 * The reply is sent as the shop's, marked as the AI's; handed to staff, the conversation waits for
 * them. Each reply spends a credit; what came of each message is kept.
 */
export class AiCustomerReplies {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [MessagingEvents.ConversationMessageReceived];

  constructor(
    private readonly database: Database,
    private readonly agent: SupportAgentService,
    private readonly conversations: Pick<ConversationsService, 'reply'>,
    private readonly ai: AiGateway,
    private readonly credits: AiCredits | null,
  ) {}

  /** What came of the message the event names; null where it was not the AI's to answer. */
  async handle(event: DomainEvent, now: Date = new Date()): Promise<SupportAgentOutcome | null> {
    const { shopId, aggregateId: conversationId } = event;
    const written = event.payload as Partial<ConversationMessageReceivedPayload>;
    if (!written.messageId) return null;
    const task = await this.agent.taskOf(shopId, conversationId, written.messageId, now);
    if (!task) return null;
    const balance = await this.credits?.balanceOf(shopId, now);
    if (balance && balance.left <= 0) {
      await this.agent.record(shopId, task, 'refused', undefined, now);
      return 'refused';
    }
    const { name, facts } = await this.database.tenant(shopId, async (tx) => {
      const profile = await shopProfile(tx, shopId);
      return { name: profile.name, facts: await factsIn(tx, shopId, task, profile.currency) };
    });
    const result = await draftSupportReply(this.ai, {
      shopName: name,
      // Its name and tone, as the shop set them (ADR-923).
      voice: task.voice,
      facts,
      history: task.history,
    });
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    if (!result.ok) {
      await this.agent.record(shopId, task, result.reason, usage, now);
      return result.reason;
    }
    const tenant: TenantContext = {
      shopId,
      currency: 'PKR',
      scopes: new Set(),
      actor: { kind: 'app', tokenId: '00000000-0000-0000-0000-000000000000' },
    };
    const sent = await this.conversations.reply(tenant, conversationId, result.value.reply, now, {
      ai: true,
    });
    if (!sent.ok) {
      await this.agent.record(shopId, task, 'unsent', usage, now);
      return 'unsent';
    }
    const outcome = result.value.handOff ? 'handed_off' : 'replied';
    if (result.value.handOff) await this.agent.handOff(shopId, conversationId, now);
    await this.agent.record(shopId, task, outcome, usage, now);
    await this.credits?.spend(shopId, 'support_reply', now);
    return outcome;
  }
}

/** What the customer's last two messages may be asking of the shop's products. */
const ASKED_TURNS = 2;

/**
 * The products the customer's latest messages may ask of (ADR-911), each a line: its price, or
 * its variants' prices, and which of them can be bought now. Stock counts are never given.
 */
export async function productFactsIn(
  tx: Tx,
  shopId: string,
  history: SupportAgentTask['history'],
  currency: string,
): Promise<string[]> {
  const asked = history
    .filter((turn) => turn.from === 'customer')
    .slice(-ASKED_TURNS)
    .map((turn) => turn.text)
    .join(' ');
  const products = await askedProductsIn(tx, shopId, asked);
  const sellable = await sellableIn(
    tx,
    shopId,
    products.flatMap((product) => product.variants.map((variant) => variant.variantId)),
  );
  const priced = (amount: bigint) =>
    isCurrencyCode(currency) ? formatMoney(money(amount, currency)) : `${amount} ${currency}`;
  const stock = (variantId: string) =>
    sellable.get(variantId) === false ? 'out of stock' : 'in stock';
  return products.map((product) => {
    const variants = product.variants.map((variant) => {
      const was =
        variant.compareAtPrice !== null && variant.compareAtPrice > variant.price
          ? ` (was ${priced(variant.compareAtPrice)})`
          : '';
      const price = `${priced(variant.price)}${was}, ${stock(variant.variantId)}`;
      return variant.title === null ? price : `${variant.title}: ${price}`;
    });
    return `${product.title}: ${variants.join('; ') || 'not for sale now'}`;
  });
}

/**
 * What the AI may answer from: the shop's policies and answers to common questions, the products
 * asked of, and the customer's own orders.
 */
async function factsIn(
  tx: Tx,
  shopId: string,
  task: SupportAgentTask,
  currency: string,
): Promise<string> {
  const policies = (await shopPoliciesOf(tx, shopId))
    .filter((policy) => (POLICY_FACTS as readonly string[]).includes(policy.type))
    .map((policy) => {
      const text = textOf(policy.body);
      return `${policy.type.replace(/_/g, ' ')}: ${text.length > POLICY_LIMIT ? `${text.slice(0, POLICY_LIMIT)}…` : text}`;
    });
  const orders = await supportFactsIn(
    tx,
    shopId,
    task.customerPhone,
    task.channel === 'web' ? orderNumbersIn(task.history) : undefined,
  );
  const faqs = task.faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`);
  const products = await productFactsIn(tx, shopId, task.history, currency);
  // The customer's own orders and the products asked of first: what is cut, should the facts
  // run long, is the end of what the shop wrote.
  return [
    orders.length > 0
      ? `The customer's orders:\n${orders.join('\n')}`
      : task.channel === 'web'
        ? 'No order of this customer is known: in this chat, they name an order by its number, such as #1023, to ask of it.'
        : 'The customer has no orders with the shop from this number.',
    products.length > 0
      ? `Products the customer may be asking of, with their prices and what is in stock now:\n${products.join('\n')}`
      : 'No product of the shop matches what the customer wrote.',
    ...(faqs.length > 0 ? [`The shop's answers to common questions:\n${faqs.join('\n')}`] : []),
    policies.length > 0
      ? `The shop's policies:\n${policies.join('\n')}`
      : 'The shop has written no policies.',
  ].join('\n\n');
}
