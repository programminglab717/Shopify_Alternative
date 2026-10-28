import {
  enabledFunctionsIn,
  hiddenPaymentMethodsOf,
  recordFunctionFailureIn,
  validationErrorsOf,
  type FunctionRunner,
  type FunctionTarget,
} from '@hatti/apps/public';
import { CheckoutFunctions, type CheckoutFunctionInput } from '@hatti/checkout/public';
import type { Tx } from '@hatti/db';

/**
 * Checkout's functions as the shop's apps give them (DEV-07, ADR-868): each turned on for the
 * target run in the runner's worker with its settings, in the order given, the answers of all
 * taken together. One that fails, runs past its time or answers in another shape says nothing,
 * and its failure is kept for the shop and the app to see.
 */
export class AppCheckoutFunctions extends CheckoutFunctions {
  constructor(private readonly runner: FunctionRunner) {
    super();
  }

  async hiddenPaymentMethods(
    tx: Tx,
    shopId: string,
    input: CheckoutFunctionInput,
  ): Promise<string[]> {
    const answers = await this.#run(
      tx,
      shopId,
      'payment_customization',
      input,
      hiddenPaymentMethodsOf,
    );
    return [...new Set(answers.flat())];
  }

  async validationErrors(tx: Tx, shopId: string, input: CheckoutFunctionInput): Promise<string[]> {
    return (await this.#run(tx, shopId, 'cart_validation', input, validationErrorsOf)).flat();
  }

  async #run<T>(
    tx: Tx,
    shopId: string,
    target: FunctionTarget,
    input: CheckoutFunctionInput,
    read: (output: unknown) => T | null,
  ): Promise<T[]> {
    const answers: T[] = [];
    for (const fn of await enabledFunctionsIn(tx, shopId, target)) {
      const result = await this.runner.run(fn.digest, fn.wasm, {
        ...input,
        configuration: fn.configuration,
      });
      const answer = result.ok ? read(result.output) : null;
      if (answer === null) {
        await recordFunctionFailureIn(
          tx,
          shopId,
          fn.id,
          result.ok ? 'Its answer was not of the shape its target asks' : result.detail,
        );
        continue;
      }
      answers.push(answer);
    }
    return answers;
  }
}
