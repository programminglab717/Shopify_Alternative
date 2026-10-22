import { shopProfile, type PublicSite } from '@hatti/api';
import type { Database } from '@hatti/db';
import { LEGAL_DOCUMENTS, type LegalDocument } from '@hatti/legal';
import type { Logger } from '@hatti/logger';
import { settingsIn, type MessagesService } from '@hatti/messaging/public';
import { sql } from 'drizzle-orm';
import { repeat } from './repeat.js';
import { tellShop } from './shop-notices.js';

/**
 * Tells every shop of a new version of Hatti's legal documents (ADR-742): its terms, privacy
 * policy, acceptable use policy, data processing agreement or list of sub-processors, at its
 * alerts number and by email to its owner, in the shop's language, from Hatti and at its cost,
 * each once. The worker records each version the first time it runs with it; one that follows an
 * earlier version of the same document is announced to the shops open before it, never the first
 * of each, which owners agreed to in opening their shops (ADR-737). A version is marked told once
 * every shop has it queued; a shop that fails is tried again next sweep, the others not twice.
 */
export class LegalChangeNotices {
  constructor(
    private readonly database: Database,
    private readonly messages: Pick<MessagesService, 'queueIn'>,
    private readonly site: PublicSite,
    private readonly logger?: Pick<Logger, 'warn' | 'info'>,
    private readonly documents: readonly LegalDocument[] = LEGAL_DOCUMENTS,
  ) {}

  /** One sweep at `at`: the shops told, of each version announced. */
  async sweep(at: Date = new Date()): Promise<number> {
    await this.#record(at);
    const { rows: due } = await this.database.system((tx) =>
      tx.execute<{ handle: string; version: string; first_seen_at: Date | string }>(sql`
        SELECT handle, version, first_seen_at FROM platform.legal_versions
         WHERE announce AND notified_at IS NULL
         ORDER BY first_seen_at, handle`),
    );
    let told = 0;
    for (const version of due) {
      const document = this.documents.find(
        (each) => each.handle === version.handle && each.version === version.version,
      );
      // A version since replaced by a newer one: the newer is announced instead.
      if (!document) {
        await this.#told(version.handle, version.version, at);
        continue;
      }
      const { rows: shops } = await this.database.system((tx) =>
        tx.execute<{ id: string }>(sql`
          SELECT id FROM control.shops
           WHERE status IN ('active', 'suspended')
             AND created_at < ${new Date(version.first_seen_at).toISOString()}::timestamptz
           ORDER BY id`),
      );
      let failed = false;
      for (const { id: shopId } of shops) {
        try {
          await this.#tell(shopId, document);
          told += 1;
        } catch (error) {
          failed = true;
          this.logger?.warn({ err: error, shopId }, 'legal notice not queued');
        }
      }
      if (!failed) {
        await this.#told(document.handle, document.version, at);
        this.logger?.info(
          { handle: document.handle, version: document.version, shops: shops.length },
          'legal change announced',
        );
      }
    }
    return told;
  }

  /** Sweeps now, then every `intervalMs`, a sweep never overlapping the last. */
  start(intervalMs: number): { stop(): Promise<void> } {
    return repeat(
      () => this.sweep(),
      intervalMs,
      (error) => this.logger?.warn({ err: error }, 'legal notices sweep failed'),
    );
  }

  /** Each document's version as of this release, announced if it follows an earlier one. */
  async #record(at: Date): Promise<void> {
    await this.database.system(async (tx) => {
      for (const document of this.documents) {
        await tx.execute(sql`
          INSERT INTO platform.legal_versions (handle, version, first_seen_at, announce)
          SELECT ${document.handle}, ${document.version}, ${at.toISOString()}::timestamptz,
                 EXISTS (SELECT 1 FROM platform.legal_versions WHERE handle = ${document.handle})
          ON CONFLICT (handle, version) DO NOTHING`);
      }
    });
  }

  async #told(handle: string, version: string, at: Date): Promise<void> {
    await this.database.system((tx) =>
      tx.execute(sql`
        UPDATE platform.legal_versions SET notified_at = ${at.toISOString()}::timestamptz
         WHERE handle = ${handle} AND version = ${version} AND notified_at IS NULL`),
    );
  }

  async #tell(shopId: string, document: LegalDocument): Promise<void> {
    await this.database.tenant(shopId, async (tx) => {
      const urdu = (await settingsIn(tx, shopId)).language === 'ur';
      await tellShop(tx, this.messages, shopId, {
        kind: 'legal_changed',
        // Once for each version, however often the sweep runs.
        dedupeKey: `legal_changed:${document.handle}:${document.version}`,
        variables: {
          shop: (await shopProfile(tx, shopId)).name,
          title: document.title[urdu ? 'ur' : 'en'],
          date: dayWords(document.version, urdu),
          url: this.site.url(`legal/${document.handle}`),
        },
      });
    });
  }
}

/** "22 October 2026", or its Urdu, from YYYY-MM-DD. */
function dayWords(day: string, urdu: boolean): string {
  return new Intl.DateTimeFormat(urdu ? 'ur-PK' : 'en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${day}T00:00:00Z`));
}
