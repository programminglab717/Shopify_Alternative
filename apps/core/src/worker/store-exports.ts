import { ROLE_SCOPES, type TenantContext } from '@hatti/api';
import type { StoreExportService } from '@hatti/files/public';
import type { Logger } from '@hatti/logger';
import type { CurrencyCode } from '@hatti/money';
import { zipFiles } from '@hatti/xlsx';
import { StoreExportError, type StoreExportBuilder } from '../store-export.js';
import { repeat } from './repeat.js';

/** What an owner is told of an export asked for by someone who is no longer one. */
export const NO_LONGER_OWNER =
  "Not made: whoever asked for it is no longer the shop's owner. Ask for another";

/** What an owner is told of a store too large for one file. */
export const TOO_LARGE = 'Not made: the store is too large to export in one file';

/**
 * Makes the whole store's exports asked for (ADM-10, ADR-415): each sweep, those waiting across
 * shops, each as the owner who asked while they still are one, zipped and kept by storage for a
 * week; and lets go of those a week old. One that fails for a reason its owner can act on, as a
 * part too large, fails; one that fails otherwise is tried again once its hold runs out.
 */
export class StoreExports {
  constructor(
    private readonly exports: StoreExportService,
    private readonly builder: StoreExportBuilder,
    private readonly logger?: Logger,
  ) {}

  /** One sweep at `at`: how many exports it made. */
  async sweep(at: Date = new Date()): Promise<number> {
    await this.exports.expire(at);
    let made = 0;
    for (const { shopId, id } of await this.exports.waiting(at)) {
      try {
        const task = await this.exports.take(shopId, id, at);
        if (!task) continue;
        if (task.role !== 'owner') {
          await this.exports.fail(shopId, id, NO_LONGER_OWNER, at);
          continue;
        }
        const tenant: TenantContext = {
          shopId,
          currency: task.currency as CurrencyCode,
          scopes: new Set(ROLE_SCOPES.owner),
          // As the owner who asked: each part's audit and watermarks name them.
          actor: {
            kind: 'staff',
            userId: task.requestedBy,
            sessionId: id,
            role: 'owner',
            authenticatedAt: at,
          },
        };
        const files = await this.builder.files(tenant, at);
        await this.exports.finish(shopId, id, zipFiles(files));
        made += 1;
      } catch (error) {
        if (error instanceof StoreExportError) {
          await this.exports.fail(shopId, id, error.message, at);
        } else if (error instanceof RangeError) {
          // Past what one file, or one string, can hold: trying again makes it no smaller.
          await this.exports.fail(shopId, id, TOO_LARGE, at);
        } else {
          // Its hold runs out, and it is tried again.
          this.logger?.warn({ err: error, shopId, storeExportId: id }, 'store export failed');
        }
      }
    }
    return made;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'store exports sweep failed'),
    );
  }
}
