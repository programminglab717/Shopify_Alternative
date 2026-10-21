import { InputChecker, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { searchKey } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// A shop's own search synonyms (SRC-04, ADR-685): groups of words that mean the same to its
// shoppers, "chappal" and "sandals", which a storefront's search reads beside Hatti's commerce
// lexicon (ADR-481). The shop keeps them all together and changes them together.

/** Events of a shop's search synonyms. Payloads are thin: fetch current state through the API. */
export const SearchSynonymEvents = {
  Updated: 'search_synonyms.updated',
} as const;

export interface SearchSynonymsUpdatedPayload {
  /** How many groups the shop keeps now. */
  groups: number;
}

/** How many groups a shop keeps, how many words a group has, and how long a word may be. */
export const SEARCH_SYNONYM_LIMITS = { groups: 100, words: 10, word: 40 } as const;

/** A group of words that mean the same, as the shop wrote them. */
export interface SearchSynonymGroup {
  words: string[];
}

/** The groups as the shop wrote them, and each as its words fold, " chappal sandal ". */
interface Kept {
  groups: SearchSynonymGroup[];
  keys: string[];
}

/** The groups checked, each word one word as the search folds it, in one group alone. */
function checkGroups(check: InputChecker, given: readonly (readonly string[])[]): Kept {
  if (given.length > SEARCH_SYNONYM_LIMITS.groups) {
    check.addMessage(
      ['groups'],
      'TOO_MANY',
      `A shop keeps ${SEARCH_SYNONYM_LIMITS.groups} groups of words at most`,
    );
  }
  const owner = new Map<string, number>();
  const groups: SearchSynonymGroup[] = [];
  const keys: string[] = [];
  given.forEach((words, index) => {
    const field = ['groups', String(index)];
    // Its own sentences: the field's last part is an index, no name to begin one with.
    if (words.length < 2) {
      check.addMessage(field, 'TOO_FEW', 'A group must have two words at least');
    }
    if (words.length > SEARCH_SYNONYM_LIMITS.words) {
      check.addMessage(
        field,
        'TOO_MANY',
        `A group may have ${SEARCH_SYNONYM_LIMITS.words} words at most`,
      );
    }
    const kept: string[] = [];
    const folded: string[] = [];
    words.forEach((given, at) => {
      const wordField = [...field, String(at)];
      const word = given.trim();
      const key = searchKey(word);
      if (word === '') {
        check.addMessage(wordField, 'BLANK', "A word can't be blank");
      } else if (word.length > SEARCH_SYNONYM_LIMITS.word) {
        check.addMessage(
          wordField,
          'TOO_LONG',
          `A word is too long (maximum is ${SEARCH_SYNONYM_LIMITS.word} characters)`,
        );
      } else if (key === '' || key.includes(' ')) {
        check.addMessage(wordField, 'INVALID', `${word} must be one word`);
      } else if (owner.get(key) === index) {
        check.addMessage(wordField, 'TAKEN', `${word} is in this group already`);
      } else if (owner.has(key)) {
        check.addMessage(wordField, 'TAKEN', `${word} is in another group already`);
      } else {
        owner.set(key, index);
        kept.push(word);
        folded.push(key);
      }
    });
    groups.push({ words: kept });
    keys.push(` ${folded.join(' ')} `);
  });
  return { groups, keys };
}

/**
 * The other words, as the search folds them, that mean what each of the shop's own words means,
 * by the word, in the caller's transaction `tx`: what a storefront's search reads beside the
 * commerce lexicon (ADR-685).
 */
export async function shopSynonymsIn(tx: Tx, shopId: string): Promise<Map<string, string[]>> {
  const { rows } = await tx.execute<{ keys: string[] }>(sql`
    SELECT keys FROM catalog.search_synonyms WHERE shop_id = ${shopId}`);
  const found = new Map<string, string[]>();
  for (const group of rows[0]?.keys ?? []) {
    const words = group.split(' ').filter(Boolean);
    for (const word of words)
      found.set(
        word,
        words.filter((other) => other !== word),
      );
  }
  return found;
}

/** A shop's own search synonyms (SRC-04, ADR-685), read and replaced together. */
@Injectable()
export class SearchSynonymService {
  constructor(private readonly db: Database) {}

  /** The shop's groups of words, as it wrote them, in its order. */
  async list(tenant: TenantContext): Promise<SearchSynonymGroup[]> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ groups: SearchSynonymGroup[] }>(sql`
        SELECT groups FROM catalog.search_synonyms WHERE shop_id = ${tenant.shopId}`);
      return rows[0]?.groups ?? [];
    });
  }

  /**
   * Replaces the shop's groups with `groups`, each of two to ten words that mean the same, a word
   * in one group alone; none takes them all away.
   */
  async set(
    tenant: TenantContext,
    groups: readonly (readonly string[])[],
  ): Promise<MutationResult<SearchSynonymGroup[]>> {
    const check = new InputChecker();
    const kept = checkGroups(check, groups);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO catalog.search_synonyms (shop_id, groups, keys)
        VALUES (${tenant.shopId}, ${JSON.stringify(kept.groups)}::jsonb,
                ${sql.param(kept.keys)}::text[])
        ON CONFLICT (shop_id) DO UPDATE
          SET groups = EXCLUDED.groups, keys = EXCLUDED.keys,
              version = catalog.search_synonyms.version + 1, updated_at = now()`);
      await appendEvent<SearchSynonymsUpdatedPayload>(tx, tenant.shopId, {
        type: SearchSynonymEvents.Updated,
        aggregateType: 'search_synonyms',
        aggregateId: tenant.shopId,
        payload: { groups: kept.groups.length },
      });
      return { ok: true, value: kept.groups };
    });
  }
}
