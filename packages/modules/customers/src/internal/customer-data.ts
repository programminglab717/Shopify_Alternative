import type { Actor } from '@hatti/api';
import type { Tx } from '@hatti/db';
import { Injectable } from '@nestjs/common';

/**
 * Another module's data about customers, such as their orders, which merging two customers must
 * carry over, erasing a customer must strip of personal data, and a customer's own export must
 * give them. Each method runs in the merge's, the erasure's or the export's transaction.
 */
export interface CustomerDataHandler {
  /** Names the module in errors, e.g. "orders". */
  readonly key: string;
  /**
   * Why the customer cannot be erased yet, e.g. orders still under way, as sentences for the
   * merchant; none if they can be.
   */
  erasureBlockers(tx: Tx, shopId: string, customerId: string): Promise<string[]>;
  /** Makes everything of `fromId` the customer `intoId`'s. Running it twice changes nothing. */
  merge(tx: Tx, shopId: string, fromId: string, intoId: string): Promise<void>;
  /** Removes the customer's personal data, keeping the records the shop must keep. */
  erase(tx: Tx, shopId: string, customer: CustomerIdentity, actor: Actor): Promise<void>;
  /**
   * What the module keeps of the customer, for the file they are given at their request: sections
   * of the file by name, such as `{ orders: [...] }`, holding plain JSON. Everything erasure would
   * take from them is in it, and the records it would keep while they still name the customer.
   */
  export(tx: Tx, shopId: string, customer: CustomerIdentity): Promise<Record<string, unknown>>;
}

/**
 * A customer, with the numbers and email that are theirs: records that name no customer, such as
 * a draft order taken in a chat, are found by them.
 */
export interface CustomerIdentity {
  id: string;
  /** E.164. */
  phones: string[];
  email: string | null;
}

/**
 * The modules that keep data about customers. They register when the application starts, as the
 * orders module does; the customers module never reads their tables.
 */
@Injectable()
export class CustomerDataRegistry {
  readonly #handlers = new Map<string, CustomerDataHandler>();

  register(handler: CustomerDataHandler): void {
    if (this.#handlers.has(handler.key)) {
      throw new Error(`Customer data handler "${handler.key}" is registered twice`);
    }
    this.#handlers.set(handler.key, handler);
  }

  get handlers(): readonly CustomerDataHandler[] {
    return [...this.#handlers.values()];
  }
}
