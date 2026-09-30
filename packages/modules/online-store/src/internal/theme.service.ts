import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { checkShopFile, platformTheme } from '@hatti/themes';
import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  OnlineStoreEvents,
  type ThemeCreatedPayload,
  type ThemeDeletedPayload,
  type ThemePublishedPayload,
  type ThemeUpdatedPayload,
} from './events.js';
import type { Page, ThemeFileRecord, ThemeRecord } from './records.js';
import { themeFiles, themes, type ThemeRoleValue, type ThemeRow } from './schema.js';
import { BASE_THEME, BASE_THEME_NAME, THEME_LIMITS, checkThemeFile } from './theme-files.js';

export interface ThemeFileInput {
  filename: string;
  body: string;
}

export interface ListThemesOptions {
  first: number;
  /** The theme to list after, by ID. */
  after?: string | null;
  roles?: ThemeRoleValue[] | null;
}

function toThemeRecord(row: ThemeRow): ThemeRecord {
  return {
    id: row.id,
    name: row.name,
    base: row.base,
    role: row.role,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The shop's main theme. A shop that has none has never touched its themes: this makes it, on
 * the platform theme with none of its own files, which the storefront shows as it would no theme.
 * Safe to race: the unique index on the main theme decides.
 */
async function ensureMainTheme(tx: Tx, shopId: string): Promise<ThemeRow> {
  const main = () =>
    tx
      .select()
      .from(themes)
      .where(and(eq(themes.shopId, shopId), eq(themes.role, 'main')));
  const [existing] = await main();
  if (existing) return existing;
  const [created] = await tx
    .insert(themes)
    .values({ shopId, id: newId(), name: BASE_THEME_NAME, base: BASE_THEME, role: 'main' })
    .onConflictDoNothing()
    .returning();
  if (created) {
    await appendEvent<ThemeCreatedPayload>(tx, shopId, {
      type: OnlineStoreEvents.ThemeCreated,
      aggregateType: 'theme',
      aggregateId: created.id,
      payload: { name: created.name, base: created.base },
    });
    return created;
  }
  const [raced] = await main();
  if (!raced) throw new Error('No main theme after making one');
  return raced;
}

/**
 * A shop's themes (ADR-039): each a platform theme with the shop's own JSON files over it, its
 * templates, section groups and settings. The main theme is the one the storefront shows; the
 * shop prepares others and publishes one to take its place. Every change raises the theme's
 * version.
 */
@Injectable()
export class ThemeService {
  constructor(private readonly db: Database) {}

  /** The shop's themes: the main one first, then the newest. */
  async list(tenant: TenantContext, options: ListThemesOptions): Promise<Page<ThemeRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await ensureMainTheme(tx, tenant.shopId);
      const conditions: SQL[] = [eq(themes.shopId, tenant.shopId)];
      if (options.roles?.length) conditions.push(inArray(themes.role, options.roles));
      const rows = await tx
        .select()
        .from(themes)
        .where(and(...conditions))
        .orderBy(sql`${themes.role} = 'main' DESC`, desc(themes.id));
      const start = options.after ? rows.findIndex((row) => row.id === options.after) + 1 : 0;
      const page = rows.slice(start, start + options.first);
      return { items: page.map(toThemeRecord), hasNextPage: rows.length > start + page.length };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<ThemeRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#find(tx, tenant.shopId, id);
      return row ? toThemeRecord(row) : null;
    });
  }

  /** The main theme, made if the shop has none yet. */
  main(tenant: TenantContext): Promise<ThemeRecord> {
    return this.db.tenant(tenant.shopId, async (tx) =>
      toThemeRecord(await ensureMainTheme(tx, tenant.shopId)),
    );
  }

  /** The shop's own files in a theme, by filename: all of them, or those of `filenames`. */
  async files(
    tenant: TenantContext,
    themeId: string,
    filenames?: readonly string[] | null,
  ): Promise<ThemeFileRecord[]> {
    return this.db.tenant(tenant.shopId, (tx) =>
      this.#files(tx, tenant.shopId, themeId, filenames),
    );
  }

  /**
   * The main theme and the shop's files in it, in the caller's transaction `tx`: for read models
   * built outside the module, such as the storefront's. Null if the shop never had one.
   */
  async mainOf(
    tx: Tx,
    shopId: string,
  ): Promise<{ theme: ThemeRecord; files: ThemeFileRecord[] } | null> {
    const [row] = await tx
      .select()
      .from(themes)
      .where(and(eq(themes.shopId, shopId), eq(themes.role, 'main')));
    if (!row) return null;
    return { theme: toThemeRecord(row), files: await this.#files(tx, shopId, row.id) };
  }

  /**
   * A theme and the shop's files in it, whether published or not, in the caller's transaction
   * `tx`: for a preview of it. Null if the shop has no such theme.
   */
  async themeOf(
    tx: Tx,
    shopId: string,
    themeId: string,
  ): Promise<{ theme: ThemeRecord; files: ThemeFileRecord[] } | null> {
    const row = await this.#find(tx, shopId, themeId);
    if (!row) return null;
    return { theme: toThemeRecord(row), files: await this.#files(tx, shopId, row.id) };
  }

  /** A new theme, not yet published: on the platform theme, or a copy of `copyFrom`'s files. */
  async create(
    tenant: TenantContext,
    input: { name: string; copyFrom?: string | null },
  ): Promise<MutationResult<ThemeRecord>> {
    const check = new InputChecker();
    const name = check.text(['name'], input.name, { required: true, max: THEME_LIMITS.name });
    if (!check.ok || name === null) return fail(check.errors);
    return this.db.tenant(tenant.shopId, async (tx) => {
      await ensureMainTheme(tx, tenant.shopId);
      const [counts] = await tx
        .select({ total: count() })
        .from(themes)
        .where(eq(themes.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= THEME_LIMITS.themes) {
        return failOne([], 'TOO_MANY', `A shop can keep at most ${THEME_LIMITS.themes} themes`);
      }
      const source = input.copyFrom ? await this.#find(tx, tenant.shopId, input.copyFrom) : null;
      if (input.copyFrom && !source) return failOne(['copyFrom'], 'NOT_FOUND', 'Theme not found');
      const [row] = await tx
        .insert(themes)
        .values({
          shopId: tenant.shopId,
          id: newId(),
          name,
          base: source?.base ?? BASE_THEME,
          role: 'unpublished',
        })
        .returning();
      if (source) {
        const copied = await this.#files(tx, tenant.shopId, source.id);
        if (copied.length > 0) {
          await tx.insert(themeFiles).values(
            copied.map((file) => ({
              shopId: tenant.shopId,
              themeId: row!.id,
              filename: file.filename,
              body: file.body,
            })),
          );
        }
      }
      await appendEvent<ThemeCreatedPayload>(tx, tenant.shopId, {
        type: OnlineStoreEvents.ThemeCreated,
        aggregateType: 'theme',
        aggregateId: row!.id,
        payload: { name: row!.name, base: row!.base },
      });
      return { ok: true, value: toThemeRecord(row!) };
    });
  }

  /** Makes a theme the main one, which the storefront shows; the one before is unpublished. */
  async publish(tenant: TenantContext, id: string): Promise<MutationResult<ThemeRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const main = await ensureMainTheme(tx, tenant.shopId);
      const theme = await this.#find(tx, tenant.shopId, id, { lock: true });
      if (!theme) return failOne(['id'], 'NOT_FOUND', 'Theme not found');
      if (theme.role === 'main') return { ok: true, value: toThemeRecord(theme) };
      await tx
        .update(themes)
        .set({ role: 'unpublished', updatedAt: sql`now()` })
        .where(and(eq(themes.shopId, tenant.shopId), eq(themes.id, main.id)));
      const [published] = await tx
        .update(themes)
        .set({ role: 'main', version: sql`${themes.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(themes.shopId, tenant.shopId), eq(themes.id, id)))
        .returning();
      await appendEvent<ThemePublishedPayload>(tx, tenant.shopId, {
        type: OnlineStoreEvents.ThemePublished,
        aggregateType: 'theme',
        aggregateId: id,
        payload: { previousId: main.id, version: published!.version },
      });
      return { ok: true, value: toThemeRecord(published!) };
    });
  }

  /** Deletes a theme the storefront does not show, with its files. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const theme = await this.#find(tx, tenant.shopId, id, { lock: true });
      if (!theme) return failOne(['id'], 'NOT_FOUND', 'Theme not found');
      if (theme.role === 'main') {
        return failOne(['id'], 'INVALID', "The main theme can't be deleted; publish another first");
      }
      await tx.delete(themes).where(and(eq(themes.shopId, tenant.shopId), eq(themes.id, id)));
      await appendEvent<ThemeDeletedPayload>(tx, tenant.shopId, {
        type: OnlineStoreEvents.ThemeDeleted,
        aggregateType: 'theme',
        aggregateId: id,
        payload: { name: theme.name },
      });
      return { ok: true, value: { id } };
    });
  }

  /** Saves files in a theme, replacing those of the same names; all of them or none. */
  async upsertFiles(
    tenant: TenantContext,
    themeId: string,
    files: readonly ThemeFileInput[],
  ): Promise<MutationResult<{ theme: ThemeRecord; files: ThemeFileRecord[] }>> {
    const check = new InputChecker();
    if (files.length === 0) check.add(['files'], 'BLANK', 'must include at least one');
    if (files.length > THEME_LIMITS.filesPerCall) {
      check.add(['files'], 'TOO_MANY', `can have at most ${THEME_LIMITS.filesPerCall}`);
    }
    const names = new Set<string>();
    files.forEach((file, index) => {
      checkThemeFile(check, ['files', String(index)], file);
      if (names.has(file.filename)) {
        check.addMessage(
          ['files', String(index), 'filename'],
          'INVALID',
          `${file.filename} is given twice`,
        );
      }
      names.add(file.filename);
    });
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const theme = await this.#find(tx, tenant.shopId, themeId, { lock: true });
      if (!theme) return failOne(['themeId'], 'NOT_FOUND', 'Theme not found');
      // Theme Check: what the storefront would make of each file, over the platform theme.
      const base = await platformTheme(theme.base);
      const checked = new InputChecker();
      files.forEach((file, index) => {
        for (const problem of checkShopFile(base, file.filename, file.body)) {
          const at = ['files', String(index), 'body'];
          checked.addMessage(at, 'INVALID', `${file.filename}: ${problem}`);
        }
      });
      if (!checked.ok) return fail(checked.errors);
      const [kept] = await tx
        .select({ total: count() })
        .from(themeFiles)
        .where(
          and(
            eq(themeFiles.shopId, tenant.shopId),
            eq(themeFiles.themeId, themeId),
            sql`${themeFiles.filename} <> ALL(${sql.param([...names])}::text[])`,
          ),
        );
      if ((kept?.total ?? 0) + names.size > THEME_LIMITS.filesPerTheme) {
        return failOne(
          ['files'],
          'TOO_MANY',
          `A theme can keep at most ${THEME_LIMITS.filesPerTheme} files of the shop's own`,
        );
      }
      const saved = await tx
        .insert(themeFiles)
        .values(
          files.map((file) => ({
            shopId: tenant.shopId,
            themeId,
            filename: file.filename,
            body: file.body,
          })),
        )
        .onConflictDoUpdate({
          target: [themeFiles.shopId, themeFiles.themeId, themeFiles.filename],
          set: { body: sql`excluded.body`, updatedAt: sql`now()` },
        })
        .returning();
      const updated = await this.#changed(tx, tenant.shopId, theme, [...names]);
      return {
        ok: true,
        value: {
          theme: updated,
          files: saved
            .map((row) => ({ filename: row.filename, body: row.body, updatedAt: row.updatedAt }))
            .sort((a, b) => a.filename.localeCompare(b.filename)),
        },
      };
    });
  }

  /** Deletes the shop's own files from a theme, so the platform theme's show again. */
  async deleteFiles(
    tenant: TenantContext,
    themeId: string,
    filenames: readonly string[],
  ): Promise<MutationResult<{ theme: ThemeRecord; deleted: string[] }>> {
    if (filenames.length === 0)
      return failOne(['files'], 'BLANK', 'Files must include at least one');
    if (filenames.length > THEME_LIMITS.filesPerCall) {
      return failOne(['files'], 'TOO_MANY', `Files can have at most ${THEME_LIMITS.filesPerCall}`);
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const theme = await this.#find(tx, tenant.shopId, themeId, { lock: true });
      if (!theme) return failOne(['themeId'], 'NOT_FOUND', 'Theme not found');
      const deleted = await tx
        .delete(themeFiles)
        .where(
          and(
            eq(themeFiles.shopId, tenant.shopId),
            eq(themeFiles.themeId, themeId),
            inArray(themeFiles.filename, [...filenames]),
          ),
        )
        .returning({ filename: themeFiles.filename });
      const names = deleted.map((row) => row.filename).sort();
      const updated =
        names.length > 0
          ? await this.#changed(tx, tenant.shopId, theme, names)
          : toThemeRecord(theme);
      return { ok: true, value: { theme: updated, deleted: names } };
    });
  }

  /** Raises a theme's version for a change to `changed`, and records it. */
  async #changed(tx: Tx, shopId: string, theme: ThemeRow, changed: string[]): Promise<ThemeRecord> {
    const [updated] = await tx
      .update(themes)
      .set({ version: sql`${themes.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(themes.shopId, shopId), eq(themes.id, theme.id)))
      .returning();
    await appendEvent<ThemeUpdatedPayload>(tx, shopId, {
      type: OnlineStoreEvents.ThemeUpdated,
      aggregateType: 'theme',
      aggregateId: theme.id,
      payload: { changed: [...changed].sort(), role: updated!.role, version: updated!.version },
    });
    return toThemeRecord(updated!);
  }

  async #find(
    tx: Tx,
    shopId: string,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<ThemeRow | undefined> {
    const query = tx
      .select()
      .from(themes)
      .where(and(eq(themes.shopId, shopId), eq(themes.id, id)));
    const [row] = options.lock ? await query.for('update') : await query;
    return row;
  }

  async #files(
    tx: Tx,
    shopId: string,
    themeId: string,
    filenames?: readonly string[] | null,
  ): Promise<ThemeFileRecord[]> {
    if (filenames?.length === 0) return [];
    const conditions = [eq(themeFiles.shopId, shopId), eq(themeFiles.themeId, themeId)];
    if (filenames) conditions.push(inArray(themeFiles.filename, [...filenames]));
    const rows = await tx
      .select({
        filename: themeFiles.filename,
        body: themeFiles.body,
        updatedAt: themeFiles.updatedAt,
      })
      .from(themeFiles)
      .where(and(...conditions))
      .orderBy(asc(themeFiles.filename));
    return rows;
  }
}
