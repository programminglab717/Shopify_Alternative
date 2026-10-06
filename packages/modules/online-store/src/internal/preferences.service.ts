import {
  InputChecker,
  checkSeo,
  fail,
  failOne,
  type FieldError,
  type MutationResult,
  type SeoInputValue,
  type TenantContext,
} from '@hatti/api';
import { ProductService } from '@hatti/catalog/public';
import { SecretBox, passwordVerifier } from '@hatti/crypto';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { readyImagesIn } from '@hatti/files/public';
import { isUuid } from '@hatti/ids';
import { parsePkMobile } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { OnlineStoreEvents, type PreferencesUpdatedPayload } from './events.js';
import type { LinkPageRecord, PreferencesRecord } from './records.js';
import { ROBOTS_RULES_LIMITS, robotsRules } from './robots-rules.js';
import { preferences } from './schema.js';

export interface PreferencesInput {
  /** A Pakistani mobile number in any common format; blank to have none. Left as it is if absent. */
  whatsappNumber?: string | null;
  /** Closes the storefront behind its password, or opens it. Left as it is if absent. */
  passwordEnabled?: boolean | null;
  /** The storefront's password, 4 to 100 characters: changed, never taken away. */
  password?: string | null;
  /** What the password page tells shoppers, up to 1,000 characters; blank for nothing. */
  passwordMessage?: string | null;
  /** Rules for the storefront's robots.txt, one a line, replacing those it had; blank for none. */
  robotsTxtRules?: string | null;
  /** Its link-in-bio page (ADR-161): each part given replaces what it had. */
  linkPage?: LinkPageInput | null;
  /** Its home page's title and description for search engines (ADR-243), as Shopify's SEO. */
  seo?: SeoInputValue | null;
  /** The image link previews show of its pages without their own (ADR-243); null for none. */
  sharingImage?: { fileId: string; altText?: string | null } | null;
}

/** What a social sharing image's words for those who cannot see it may be, as a file's alt. */
export const SHARING_IMAGE_ALT_MAX = 512;

export interface LinkPageInput {
  /** Up to 300 characters; blank for none. */
  bio?: string | null;
  /** Up to 10, in their order: a title, and a path on the storefront or an https address. */
  links?: readonly { title: string; url: string }[] | null;
  /** Up to 24 of the shop's products, in their order. */
  productIds?: readonly string[] | null;
  /**
   * As `productIds`, each with one of its variants chosen, or none (ADR-206); in place of
   * `productIds`, not with it.
   */
  products?: readonly { productId: string; variantId?: string | null }[] | null;
}

export const LINK_PAGE_LIMITS = {
  bio: 300,
  links: 10,
  title: 60,
  url: 2_048,
  products: 24,
} as const;

/** The shop's preferences as its staff see them, the storefront's password among them. */
export interface PreferencesView extends PreferencesRecord {
  /** Null until one is set. */
  password: string | null;
}

export const PASSWORD_LENGTH = { min: 4, max: 100 } as const;
export const PASSWORD_MESSAGE_MAX = 1_000;

type PreferencesRow = typeof preferences.$inferSelect;

/**
 * What a shop sets for its storefront as a whole (ADR-041): the WhatsApp number its "Order on
 * WhatsApp" links and WhatsApp section go to, the password it is closed behind until it opens
 * (ADR-054), rules it adds to its robots.txt (ADR-055), and its home page's title, description
 * and social sharing image for search engines and link previews (ADR-243). A shop that set
 * nothing has no number, an open storefront, the platform's robots.txt, and its name for its home
 * page.
 */
@Injectable()
export class PreferencesService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    /** For the products a link page shows. */
    private readonly products: ProductService,
  ) {}

  async get(tenant: TenantContext): Promise<PreferencesView> {
    return this.db.tenant(tenant.shopId, async (tx) =>
      this.#current(tx, tenant.shopId, this.#view(tenant.shopId, await rowOf(tx, tenant.shopId))),
    );
  }

  /** Changes those given; records `online_store_preferences.updated` if any changed. */
  async update(
    tenant: TenantContext,
    input: PreferencesInput,
  ): Promise<MutationResult<PreferencesView>> {
    const check = new InputChecker();
    let whatsapp: string | null | undefined;
    if (input.whatsappNumber !== undefined) {
      const text = input.whatsappNumber?.trim() ?? '';
      const mobile = text === '' ? null : parsePkMobile(text);
      if (text !== '' && !mobile) {
        check.addMessage(
          ['whatsappNumber'],
          'INVALID',
          'WhatsApp number must be a Pakistani mobile number, like 0300 1234567',
        );
      }
      whatsapp = mobile?.e164 ?? null;
    }
    let password: string | undefined;
    if (input.password !== undefined) {
      const text = input.password?.trim() ?? '';
      if (
        text.length < PASSWORD_LENGTH.min ||
        text.length > PASSWORD_LENGTH.max ||
        /\p{Cc}/u.test(text)
      ) {
        check.addMessage(
          ['password'],
          'INVALID',
          `Password must be ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters`,
        );
      } else password = text;
    }
    let message: string | undefined;
    if (input.passwordMessage !== undefined) {
      message = (input.passwordMessage ?? '').replace(/\r\n?/g, '\n').trim();
      if (message.length > PASSWORD_MESSAGE_MAX) {
        check.addMessage(
          ['passwordMessage'],
          'TOO_LONG',
          'Message is too long (maximum is 1,000 characters)',
        );
      } else if (/[^\P{Cc}\n\t]/u.test(message)) {
        check.addMessage(['passwordMessage'], 'INVALID', 'Message has characters it cannot show');
      }
    }
    let robots: string | undefined;
    if (input.robotsTxtRules !== undefined) {
      const text = input.robotsTxtRules ?? '';
      const { rules, problems } = robotsRules(text);
      if (
        text.length > ROBOTS_RULES_LIMITS.length ||
        rules.split('\n').length > ROBOTS_RULES_LIMITS.lines
      ) {
        check.addMessage(
          ['robotsTxtRules'],
          'TOO_LONG',
          `Rules are too long (at most ${ROBOTS_RULES_LIMITS.lines} lines)`,
        );
      } else if (problems.length > 0) {
        for (const problem of problems.slice(0, 5)) {
          check.addMessage(['robotsTxtRules'], 'INVALID', problem);
        }
      } else robots = rules;
    }
    const linkPage = input.linkPage ? checkLinkPage(check, input.linkPage) : undefined;
    const seo = checkSeo(check, ['seo'], input.seo);
    const sharingAlt = input.sharingImage
      ? (check.text(['sharingImage', 'altText'], input.sharingImage.altText ?? '', {
          max: SHARING_IMAGE_ALT_MAX,
        }) ?? '')
      : '';
    if (!check.ok) return fail(check.errors);
    // Some 50 ms of scrypt, before the transaction rather than inside it.
    const verifier = password === undefined ? undefined : await passwordVerifier(password);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const before = await rowOf(tx, tenant.shopId, { lock: true });
      const was = await this.#current(tx, tenant.shopId, this.#view(tenant.shopId, before));
      if (linkPage?.productIds && linkPage.productIds.length > 0) {
        const found = await this.#found(tx, tenant.shopId, linkPage.productIds);
        const missing = missingOf(input.linkPage!, found);
        if (missing.length > 0) return fail(missing);
      }
      // An image among the shop's files a page can show, as an article's is (ADR-213).
      const image = input.sharingImage;
      if (
        image &&
        !(isUuid(image.fileId) && (await readyImagesIn(tx, tenant.shopId, [image.fileId])).size)
      ) {
        return failOne(
          ['sharingImage', 'fileId'],
          'NOT_FOUND',
          "No such image among the shop's files: a JPEG, PNG, WebP or GIF uploaded",
        );
      }
      const next = {
        whatsapp: whatsapp === undefined ? was.whatsappNumber : whatsapp,
        passwordEnabled: input.passwordEnabled ?? was.passwordEnabled,
        // The same password again keeps its verifier, and the passes shoppers hold.
        password: password ?? was.password,
        passwordMessage: message ?? was.passwordMessage,
        robotsTxtRules: robots ?? was.robotsTxtRules,
        linkPage: {
          bio: linkPage?.bio ?? was.linkPage.bio,
          links: linkPage?.links ?? was.linkPage.links,
          productIds: linkPage?.productIds ?? was.linkPage.productIds,
          variantIds: linkPage?.variantIds ?? was.linkPage.variantIds,
        },
        seo: { ...was.seo, ...seo },
        sharingImage:
          image === undefined
            ? was.sharingImage
            : image && { fileId: image.fileId, altText: sharingAlt },
      };
      if (next.passwordEnabled && next.password === null) {
        return failOne(
          ['password'],
          'BLANK',
          'Set a password before closing the storefront behind it',
        );
      }
      const changed = [
        ...(next.whatsapp !== was.whatsappNumber ? ['whatsappNumber'] : []),
        ...(next.passwordEnabled !== was.passwordEnabled ? ['passwordEnabled'] : []),
        ...(next.password !== was.password ? ['password'] : []),
        ...(next.passwordMessage !== was.passwordMessage ? ['passwordMessage'] : []),
        ...(next.robotsTxtRules !== was.robotsTxtRules ? ['robotsTxtRules'] : []),
        ...(JSON.stringify(next.linkPage) !== JSON.stringify(was.linkPage) ? ['linkPage'] : []),
        ...(JSON.stringify(next.seo) !== JSON.stringify(was.seo) ? ['seo'] : []),
        ...(JSON.stringify(next.sharingImage) !== JSON.stringify(was.sharingImage)
          ? ['sharingImage']
          : []),
      ];
      if (changed.length === 0) return { ok: true, value: was };
      const newPassword = changed.includes('password') && next.password !== null;
      const values = {
        whatsapp: next.whatsapp,
        passwordEnabled: next.passwordEnabled,
        passwordSealed: newPassword
          ? this.box.encrypt(next.password!, sealedFor(tenant.shopId))
          : (before?.passwordSealed ?? null),
        passwordVerifier: newPassword ? verifier! : (before?.passwordVerifier ?? null),
        passwordMessage: next.passwordMessage,
        robotsTxtRules: next.robotsTxtRules,
        linkBio: next.linkPage.bio,
        linkLinks: next.linkPage.links,
        linkProducts: next.linkPage.productIds,
        linkVariants: next.linkPage.variantIds,
        seoTitle: next.seo.title,
        seoDescription: next.seo.description,
        sharingImageId: next.sharingImage?.fileId ?? null,
        sharingImageAlt: next.sharingImage?.altText ?? '',
      };
      const [row] = await tx
        .insert(preferences)
        .values({ shopId: tenant.shopId, ...values })
        .onConflictDoUpdate({
          target: preferences.shopId,
          set: { ...values, updatedAt: sql`now()` },
        })
        .returning();
      await appendEvent<PreferencesUpdatedPayload>(tx, tenant.shopId, {
        type: OnlineStoreEvents.PreferencesUpdated,
        aggregateType: 'online_store_preferences',
        aggregateId: tenant.shopId,
        payload: { changed },
      });
      return { ok: true, value: this.#view(tenant.shopId, row) };
    });
  }

  /**
   * The shop's preferences, in the caller's transaction `tx`: for read models built outside the
   * module, such as the storefront's.
   */
  async preferencesOf(
    tx: Tx,
    shopId: string,
    options: { lock?: boolean } = {},
  ): Promise<PreferencesRecord> {
    return toRecord(await rowOf(tx, shopId, options));
  }

  /**
   * The view with the link page's products that are gone since left out (ADR-161), and the
   * variants chosen that are gone since no longer chosen (ADR-206).
   */
  async #current(tx: Tx, shopId: string, view: PreferencesView): Promise<PreferencesView> {
    const { productIds, variantIds } = view.linkPage;
    if (productIds.length === 0) return view;
    const found = await this.#found(tx, shopId, productIds);
    const kept = shownOnce(
      productIds.flatMap((productId, index) => {
        const variants = found.get(productId);
        if (!variants) return [];
        const variantId = variantIds[index] ?? null;
        return [
          {
            productId,
            variantId: variantId !== null && variants.has(variantId) ? variantId : null,
          },
        ];
      }),
    );
    const same =
      kept.length === productIds.length &&
      kept.every((each, index) => each.variantId === (variantIds[index] ?? null));
    if (same) return view;
    return {
      ...view,
      linkPage: {
        ...view.linkPage,
        productIds: kept.map((each) => each.productId),
        variantIds: kept.map((each) => each.variantId),
      },
    };
  }

  /** Those of `ids` the shop has products by, whatever their status, with their variants' IDs. */
  async #found(tx: Tx, shopId: string, ids: readonly string[]): Promise<Map<string, Set<string>>> {
    const records = await this.products.recordsOf(tx, shopId, ids);
    return new Map(
      records.map((product) => [
        product.id,
        new Set(product.variants.map((variant) => variant.id)),
      ]),
    );
  }

  #view(shopId: string, row: PreferencesRow | undefined): PreferencesView {
    const password = row?.passwordSealed
      ? this.box.decrypt(row.passwordSealed, sealedFor(shopId)).toString('utf8')
      : null;
    return { ...toRecord(row), password };
  }
}

/**
 * The shop's preferences, in the caller's transaction `tx`, as {@link PreferencesService} gives
 * read models them, for those without the service: its password's verifier, never the password.
 */
export async function shopPreferencesOf(tx: Tx, shopId: string): Promise<PreferencesRecord> {
  return toRecord(await rowOf(tx, shopId));
}

async function rowOf(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<PreferencesRow | undefined> {
  const query = tx.select().from(preferences).where(eq(preferences.shopId, shopId));
  const [row] = options.lock ? await query.for('update') : await query;
  return row;
}

function toRecord(row: PreferencesRow | undefined): PreferencesRecord {
  return {
    whatsappNumber: row?.whatsapp ?? null,
    passwordEnabled: row?.passwordEnabled ?? false,
    passwordVerifier: row?.passwordVerifier ?? null,
    passwordMessage: row?.passwordMessage ?? '',
    robotsTxtRules: row?.robotsTxtRules ?? '',
    linkPage: {
      bio: row?.linkBio ?? '',
      links: row?.linkLinks ?? [],
      productIds: row?.linkProducts ?? [],
      // None chosen for the products of pages saved before variants could be.
      variantIds: (row?.linkProducts ?? []).map((_, index) => row?.linkVariants[index] ?? null),
    },
    seo: { title: row?.seoTitle ?? null, description: row?.seoDescription ?? null },
    sharingImage: row?.sharingImageId
      ? { fileId: row.sharingImageId, altText: row.sharingImageAlt }
      : null,
  };
}

/**
 * A link page's parts as given (ADR-161), checked: what was left out stays as it is. A link goes
 * to a path on the shop's own storefront, as "/collections/sale", or to an https address.
 */
function checkLinkPage(check: InputChecker, input: LinkPageInput): Partial<LinkPageRecord> {
  const field = (...path: (string | number)[]) => ['linkPage', ...path.map(String)];
  const page: Partial<LinkPageRecord> = {};
  if (input.bio !== undefined) {
    const bio = (input.bio ?? '').replace(/\r\n?/g, '\n').trim();
    if (bio.length > LINK_PAGE_LIMITS.bio) {
      check.addMessage(field('bio'), 'TOO_LONG', 'Bio is too long (maximum is 300 characters)');
    } else if (/[^\P{Cc}\n]/u.test(bio)) {
      check.addMessage(field('bio'), 'INVALID', 'Bio has characters it cannot show');
    } else page.bio = bio;
  }
  if (input.links !== undefined) {
    const links = input.links ?? [];
    if (links.length > LINK_PAGE_LIMITS.links) {
      check.addMessage(field('links'), 'TOO_LONG', 'A link page takes 10 links at most');
    } else {
      page.links = links.map((link, index) => {
        const title = check.text(field('links', index, 'title'), link.title, {
          required: true,
          max: LINK_PAGE_LIMITS.title,
        });
        const url = link.url.trim();
        if (!linkAddress(url)) {
          check.addMessage(
            field('links', index, 'url'),
            'INVALID',
            'Link must be a path on the store, like /collections/sale, or an https:// address',
          );
        }
        return { title: title ?? '', url };
      });
    }
  }
  if (input.productIds !== undefined && input.products !== undefined) {
    check.addMessage(field('products'), 'INVALID', 'Give products or productIds, not both');
  } else if (input.productIds !== undefined || input.products !== undefined) {
    const name = input.products !== undefined ? 'products' : 'productIds';
    const shown = shownOnce(
      input.products !== undefined
        ? (input.products ?? []).map((each) => ({
            productId: each.productId,
            variantId: each.variantId ?? null,
          }))
        : (input.productIds ?? []).map((productId) => ({ productId, variantId: null })),
    );
    if (shown.length > LINK_PAGE_LIMITS.products) {
      check.addMessage(field(name), 'TOO_LONG', 'A link page shows 24 products at most');
    } else {
      page.productIds = shown.map((each) => each.productId);
      page.variantIds = shown.map((each) => each.variantId);
    }
  }
  return page;
}

/** Each product once, as first given; one twice only with two of its variants (ADR-206). */
function shownOnce<T extends { productId: string; variantId: string | null }>(given: T[]): T[] {
  const seen = new Set<string>();
  return given.filter(({ productId, variantId }) => {
    const key = `${productId} ${variantId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where the products given are not the shop's, or a variant chosen is not of its product: by the
 * place each was given at.
 */
function missingOf(input: LinkPageInput, found: Map<string, Set<string>>): FieldError[] {
  const field = (...path: (string | number)[]) => ['linkPage', ...path.map(String)];
  if (input.products) {
    return input.products.flatMap((each, index): FieldError[] => {
      const variants = found.get(each.productId);
      if (!variants) {
        return [
          {
            field: field('products', index, 'productId'),
            code: 'NOT_FOUND',
            message: 'Product not found',
          },
        ];
      }
      if (each.variantId && !variants.has(each.variantId)) {
        return [
          {
            field: field('products', index, 'variantId'),
            code: 'NOT_FOUND',
            message: 'Variant not found on this product',
          },
        ];
      }
      return [];
    });
  }
  return (input.productIds ?? []).flatMap((id, index): FieldError[] =>
    found.has(id)
      ? []
      : [{ field: field('productIds', index), code: 'NOT_FOUND', message: 'Product not found' }],
  );
}

/** Whether a link page may link `url`: a path on the storefront, or an https address. */
function linkAddress(url: string): boolean {
  if (url.length === 0 || url.length > LINK_PAGE_LIMITS.url || /[\s\p{Cc}]/u.test(url)) {
    return false;
  }
  if (url.startsWith('/')) return !url.startsWith('//') && !url.startsWith('/\\');
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** What a shop's sealed password is bound to: it opens for that shop alone. */
function sealedFor(shopId: string): string {
  return `storefront-password:${shopId}`;
}
