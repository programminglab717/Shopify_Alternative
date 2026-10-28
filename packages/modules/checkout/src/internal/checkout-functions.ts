import type { Tx } from '@hatti/db';
import type { CartJson } from '@hatti/storefront-api';

// Apps' functions at checkout (DEV-07, CHK-20, ADR-868): the host runs the shop's apps' functions
// on what checkout is about to offer, and checkout takes their answers: the ways to pay a payment
// customisation hides, and what a cart validation says is wrong, which refuses the order. A
// function that fails or runs past its time says nothing, so checkout goes on without it.

/** What a function reads: the cart, where it goes, and the ways to pay checkout would offer. */
export interface CheckoutFunctionInput {
  cart: {
    /** The items' subtotal, in paisa. */
    subtotal: number;
    currency: string;
    lines: {
      variantId: string;
      productId: string;
      title: string;
      variantTitle: string;
      sku: string | null;
      quantity: number;
      /** Each, in paisa. */
      price: number;
    }[];
  };
  /** Where it goes, as the shopper typed it so far; null before they have. */
  deliveryAddress: { city: string; province: string } | null;
  paymentMethods: string[];
}

/** The host's runner of the shop's apps' functions, which checkout asks. */
export abstract class CheckoutFunctions {
  /** The ways to pay the shop's payment customisations hide. */
  abstract hiddenPaymentMethods(
    tx: Tx,
    shopId: string,
    input: CheckoutFunctionInput,
  ): Promise<string[]>;

  /** What the shop's cart validations say is wrong; none to place the order. */
  abstract validationErrors(
    tx: Tx,
    shopId: string,
    input: CheckoutFunctionInput,
  ): Promise<string[]>;
}

/** A function's input of `cart`, to `form`'s city and province, with these ways to pay. */
export function functionInputOf(
  cart: CartJson,
  currency: string,
  form: { city: string; province: string },
  paymentMethods: string[],
): CheckoutFunctionInput {
  return {
    cart: {
      subtotal: cart.subtotal,
      currency,
      lines: cart.items.map((item) => ({
        variantId: item.variantId,
        productId: item.productId,
        title: item.title,
        variantTitle: item.variantTitle,
        sku: item.sku,
        quantity: item.quantity,
        price: item.price,
      })),
    },
    deliveryAddress: form.city.trim()
      ? { city: form.city.trim(), province: form.province.trim() }
      : null,
    paymentMethods,
  };
}
