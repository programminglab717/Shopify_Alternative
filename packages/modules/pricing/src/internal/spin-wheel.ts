import { randomInt } from 'node:crypto';
import {
  InputChecker,
  fail,
  shopProfile,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SignUpService } from '@hatti/customers/public';
import { Database, toDate, type Tx } from '@hatti/db';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import {
  spinsPath,
  type SpinErrorResponse,
  type SpinResponse,
  type SpinWheelResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { checkCode, insertCodeIn, type DiscountCodeInput } from './discount-code.service.js';
import { DISCOUNT_CODE_LIMIT } from './discounts.js';

/** What a slice gives: a share or an amount off the order's items, free delivery, or nothing. */
export type SpinSliceKind = 'percentage' | 'amount' | 'free_shipping' | 'none';

export interface SpinSlice {
  /** The words on the wheel: "10% off". */
  label: string;
  kind: SpinSliceKind;
  /** Percent off, 0.01 to 100, for a `percentage` slice. */
  percentage: number | null;
  /** Off the items, in minor units, for an `amount` slice. */
  amount: bigint | null;
  /** How often the wheel stops at it, against the others': 1 to 100. */
  weight: number;
}

/** A shop's wheel of offers on its sign-up pop-up (OS-08, ADR-900). */
export interface SpinWheelRecord {
  enabled: boolean;
  slices: SpinSlice[];
  /** How long a shopper's code works. */
  codeDays: number;
  /** What an order's items must come to for a code to work, in minor units; null for nothing. */
  minimumSubtotal: bigint | null;
  /** Numbers that have spun, and the orders their codes were used on. */
  spins: number;
  codesUsed: number;
  version: number;
  updatedAt: Date | null;
}

/** A slice as staff give it, its amount in major units: "500". */
export interface SpinSliceInput {
  label: string;
  kind: SpinSliceKind;
  percentage?: number | null;
  amount?: string | null;
  weight: number;
}

/** Changes of the wheel; left out, a field stays as it is. */
export interface SpinWheelInput {
  enabled?: boolean | null;
  slices?: readonly SpinSliceInput[] | null;
  codeDays?: number | null;
  /** In major units; null or blank for no minimum. */
  minimumSubtotal?: string | null;
}

export type SpinOutcome =
  | {
      ok: true;
      slice: number;
      label: string;
      code: string | null;
      endsAt: Date | null;
      again: boolean;
    }
  | { ok: false; errors: FieldError[] };

/** A wheel has this many slices, at fewest and most. */
export const SPIN_SLICES = { min: 2, max: 8 } as const;

/** A slice's words are this long at most, to fit the wheel. */
export const SPIN_LABEL_MAX = 24;

/** Letters and digits a code is made of: none mistaken for another, as O for 0. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEFAULT_CODE_DAYS = 7;

interface WheelRow extends Record<string, unknown> {
  enabled: boolean;
  slices: StoredSlice[];
  code_days: number;
  minimum_subtotal: string | null;
  version: number;
  updated_at: Date | string;
}

/** A slice as it is kept, its amount in minor units as a string. */
interface StoredSlice {
  label: string;
  kind: SpinSliceKind;
  percentage: number | null;
  amount: string | null;
  weight: number;
}

/**
 * Spin to win (OS-08, ADR-900): a shop's wheel of 2 to 8 offers on its sign-up pop-up. A shopper
 * gives their number and is signed up for the shop's news and offers, tagged `spin`; the wheel
 * stops at a slice chosen by its weight, here, never on the page, and a slice that gives
 * something becomes a code of the shopper's own, for one order, for the wheel's days. Once a
 * number: spinning again answers the same slice and code. Every slice can come up: none weighs
 * nothing.
 */
@Injectable()
export class SpinWheelService {
  constructor(
    private readonly db: Database,
    private readonly signUps: SignUpService,
  ) {}

  async get(tenant: TenantContext): Promise<SpinWheelRecord> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await wheelIn(tx, tenant.shopId);
      const { rows } = await tx.execute<{ spins: number; used: number }>(sql`
        SELECT count(*)::int AS spins,
               (SELECT count(*)::int FROM pricing.discount_redemptions r
                  JOIN pricing.spins s ON s.shop_id = r.shop_id AND s.code_id = r.code_id
                 WHERE r.shop_id = ${tenant.shopId}) AS used
          FROM pricing.spins WHERE shop_id = ${tenant.shopId}`);
      return {
        ...toRecord(row),
        spins: rows[0]?.spins ?? 0,
        codesUsed: rows[0]?.used ?? 0,
      };
    });
  }

  /** Changes the wheel; turned on, it must have its slices. */
  async update(
    tenant: TenantContext,
    input: SpinWheelInput,
  ): Promise<MutationResult<SpinWheelRecord>> {
    const check = new InputChecker();
    const slices =
      input.slices === undefined || input.slices === null
        ? null
        : checkSlices(check, tenant.currency, input.slices);
    const codeDays = check.integer(['codeDays'], input.codeDays, { min: 1, max: 90 });
    const minimum =
      input.minimumSubtotal === undefined
        ? undefined
        : check.price(['minimumSubtotal'], input.minimumSubtotal, tenant.currency);
    if (minimum === 0n) check.add(['minimumSubtotal'], 'INVALID', 'must be more than zero');
    if (!check.ok) return fail(check.errors);

    await this.db.tenant(tenant.shopId, async (tx) => {
      const current = await wheelIn(tx, tenant.shopId);
      const kept = slices ?? current?.slices ?? [];
      const enabled = input.enabled ?? current?.enabled ?? false;
      if (enabled && kept.length < SPIN_SLICES.min) {
        check.addMessage(
          ['slices'],
          'BLANK',
          `A wheel turned on has ${SPIN_SLICES.min} to ${SPIN_SLICES.max} slices`,
        );
        return;
      }
      const keptMinimum =
        minimum === undefined ? (current?.minimum_subtotal ?? null) : (minimum?.toString() ?? null);
      await tx.execute(sql`
        INSERT INTO pricing.spin_wheels (shop_id, enabled, slices, code_days, minimum_subtotal)
        VALUES (${tenant.shopId}, ${enabled}, ${JSON.stringify(kept)}::jsonb,
                ${codeDays ?? current?.code_days ?? DEFAULT_CODE_DAYS}, ${keptMinimum})
        ON CONFLICT (shop_id) DO UPDATE
           SET enabled = EXCLUDED.enabled, slices = EXCLUDED.slices,
               code_days = EXCLUDED.code_days, minimum_subtotal = EXCLUDED.minimum_subtotal,
               version = pricing.spin_wheels.version + 1, updated_at = now()`);
    });
    if (!check.ok) return fail(check.errors);
    return { ok: true, value: await this.get(tenant) };
  }

  /** The wheel's slices' words, for a page to draw; null while the shop has none turned on. */
  async wheel(shopId: string): Promise<{ slices: { label: string }[] } | null> {
    const row = await this.db.tenant(shopId, (tx) => wheelIn(tx, shopId));
    if (!row?.enabled || row.slices.length < SPIN_SLICES.min) return null;
    return { slices: row.slices.map((slice) => ({ label: slice.label })) };
  }

  /**
   * The shopper with `input.phone` spins: signed up as the shop's form signs them up, their slice
   * chosen and their code made; or the slice and code they had, for a number that spun before.
   * Null while the shop has no wheel turned on.
   */
  async spin(
    shopId: string,
    input: { phone?: string | null; consent?: string | null },
  ): Promise<SpinOutcome | null> {
    const row = await this.db.tenant(shopId, (tx) => wheelIn(tx, shopId));
    if (!row?.enabled || row.slices.length < SPIN_SLICES.min) return null;
    const check = new InputChecker();
    const phone = check.mobile(['phone'], input.phone, { required: true });
    if (!check.ok || !phone) return { ok: false, errors: check.errors };
    const signed = await this.signUps.signUp(shopId, {
      phone,
      tags: 'spin',
      consent: input.consent ?? null,
    });
    if (!signed.ok) return signed;

    return this.db.tenant(shopId, async (tx) => {
      const before = await spinIn(tx, shopId, phone);
      if (before) return before;
      const wheel = await wheelIn(tx, shopId);
      if (!wheel) throw new Error(`Shop ${shopId}'s wheel went while spinning`);
      const chosen = chooseSlice(wheel.slices);
      const slice = wheel.slices[chosen]!;
      if (slice.kind !== 'none') {
        const { rows: counted } = await tx.execute<{ total: number }>(sql`
          SELECT count(*)::int AS total FROM pricing.discount_codes WHERE shop_id = ${shopId}`);
        if ((counted[0]?.total ?? 0) >= DISCOUNT_CODE_LIMIT) {
          const message = 'The shop gives no more codes just now';
          return { ok: false, errors: [{ field: [], code: 'TOO_MANY', message }] };
        }
      }
      // A second spin of the number at once waits here for the first, and answers as it did.
      const { rows: taken } = await tx.execute(sql`
        INSERT INTO pricing.spins (shop_id, phone, slice, label)
        VALUES (${shopId}, ${phone}, ${chosen}, ${slice.label})
        ON CONFLICT (shop_id, phone) DO NOTHING
        RETURNING phone`);
      if (taken.length === 0) return (await spinIn(tx, shopId, phone))!;
      if (slice.kind === 'none') {
        return {
          ok: true,
          slice: chosen,
          label: slice.label,
          code: null,
          endsAt: null,
          again: false,
        };
      }
      const currency = (await shopProfile(tx, shopId)).currency as CurrencyCode;
      const endsAt = new Date(Date.now() + wheel.code_days * 86_400_000);
      const checked = checkCode({ currency }, codeInput(slice, currency, wheel, endsAt), null);
      if (!checked.ok) throw new Error(`Shop ${shopId}'s slice ${chosen} gives no code`);
      const made = await insertCodeIn(tx, shopId, checked.value);
      await tx.execute(sql`
        UPDATE pricing.spins SET code_id = ${made.id}, code = ${made.code}, ends_at = ${endsAt}
         WHERE shop_id = ${shopId} AND phone = ${phone}`);
      return {
        ok: true,
        slice: chosen,
        label: slice.label,
        code: made.code,
        endsAt,
        again: false,
      };
    });
  }
}

/** The shop's wheel, in the caller's transaction; null for one never set. */
async function wheelIn(tx: Tx, shopId: string): Promise<WheelRow | null> {
  const { rows } = await tx.execute<WheelRow>(sql`
    SELECT enabled, slices, code_days, minimum_subtotal::text AS minimum_subtotal, version,
           updated_at
      FROM pricing.spin_wheels WHERE shop_id = ${shopId}`);
  return rows[0] ?? null;
}

/** The number's spin, as it went, in the caller's transaction; null for one never made. */
async function spinIn(tx: Tx, shopId: string, phone: string): Promise<SpinOutcome | null> {
  const { rows } = await tx.execute<{
    slice: number;
    label: string;
    code: string | null;
    ends_at: Date | string | null;
  }>(sql`
    SELECT slice, label, code, ends_at FROM pricing.spins
     WHERE shop_id = ${shopId} AND phone = ${phone}`);
  const row = rows[0];
  if (!row) return null;
  return {
    ok: true,
    slice: row.slice,
    label: row.label,
    code: row.code,
    endsAt: row.ends_at === null ? null : toDate(row.ends_at),
    again: true,
  };
}

/** A slice, by its place, chosen by the slices' weights. */
export function chooseSlice(slices: readonly { weight: number }[]): number {
  const total = slices.reduce((sum, slice) => sum + slice.weight, 0);
  let left = randomInt(total);
  for (const [index, slice] of slices.entries()) {
    if (left < slice.weight) return index;
    left -= slice.weight;
  }
  return slices.length - 1;
}

/** A shopper's code for `slice`: one order, one a customer, until `endsAt`. */
function codeInput(
  slice: StoredSlice,
  currency: CurrencyCode,
  wheel: WheelRow,
  endsAt: Date,
): DiscountCodeInput {
  let code = 'SPIN-';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const major = (minor: string | null) =>
    minor === null ? null : toMajorString(money(BigInt(minor), currency));
  return {
    code,
    title: `Spin to win: ${slice.label}`,
    ...(slice.kind === 'percentage' && { percentage: slice.percentage }),
    ...(slice.kind === 'amount' && { amount: major(slice.amount) }),
    ...(slice.kind === 'free_shipping' && { freeShipping: true }),
    minimumSubtotal: major(wheel.minimum_subtotal),
    endsAt,
    usageLimit: 1,
    oncePerCustomer: true,
  };
}

/** The slices given, checked as codes are, each error under its slice. */
function checkSlices(
  check: InputChecker,
  currency: CurrencyCode,
  given: readonly SpinSliceInput[],
): StoredSlice[] {
  if (given.length < SPIN_SLICES.min || given.length > SPIN_SLICES.max) {
    check.addMessage(
      ['slices'],
      'INVALID',
      `A wheel has ${SPIN_SLICES.min} to ${SPIN_SLICES.max} slices`,
    );
    return [];
  }
  return given.map((slice, index) => {
    const field = (name: string) => ['slices', String(index), name];
    const label = check.text(field('label'), slice.label, { required: true, max: SPIN_LABEL_MAX });
    const weight = check.integer(field('weight'), slice.weight, { min: 1, max: 100 });
    const stored: StoredSlice = {
      label: label ?? '',
      kind: slice.kind,
      percentage: null,
      amount: null,
      weight: weight ?? 1,
    };
    if (slice.kind === 'none') return stored;
    const offer = checkCode(
      { currency },
      {
        code: 'SLICE',
        ...(slice.kind === 'percentage' && { percentage: slice.percentage ?? null }),
        ...(slice.kind === 'amount' && { amount: slice.amount ?? null }),
        ...(slice.kind === 'free_shipping' && { freeShipping: true }),
      },
      null,
    );
    if (!offer.ok) {
      for (const error of offer.errors) {
        check.addMessage(['slices', String(index), ...error.field], error.code, error.message);
      }
      return stored;
    }
    if (slice.kind === 'percentage') stored.percentage = offer.value.percentageBps! / 100;
    if (slice.kind === 'amount') stored.amount = offer.value.amount!.toString();
    return stored;
  });
}

function toRecord(row: WheelRow | null): Omit<SpinWheelRecord, 'spins' | 'codesUsed'> {
  return {
    enabled: row?.enabled ?? false,
    slices: (row?.slices ?? []).map((slice) => ({
      label: slice.label,
      kind: slice.kind,
      percentage: slice.percentage,
      amount: slice.amount === null ? null : BigInt(slice.amount),
      weight: slice.weight,
    })),
    codeDays: row?.code_days ?? DEFAULT_CODE_DAYS,
    minimumSubtotal: row?.minimum_subtotal ? BigInt(row.minimum_subtotal) : null,
    version: row?.version ?? 0,
    updatedAt: row ? toDate(row.updated_at) : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Spins of shops' wheels, as storefronts send them on (ADR-900): `GET
 * /storefront/shops/{shop}/spins`, the wheel's slices to draw, and `POST` with the shopper's
 * `phone` and `consent`, their slice and code. 404 while the shop has no wheel turned on; 422
 * says what was wrong. The host application checks the storefront key before any of this runs.
 */
@Controller(spinsPath(':shopId').slice(1))
export class SpinWheelController {
  constructor(private readonly wheels: SpinWheelService) {}

  @Get()
  @Header('cache-control', 'no-store')
  async wheel(@Param('shopId') shopId: string): Promise<SpinWheelResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const wheel = await this.wheels.wheel(shopId);
    if (!wheel) throw new NotFoundException();
    return wheel;
  }

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async spin(@Param('shopId') shopId: string, @Body() body: unknown): Promise<SpinResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : null);
    const result = await this.wheels.spin(shopId, {
      phone: text('phone'),
      consent: text('consent'),
    });
    if (!result) throw new NotFoundException();
    if (!result.ok) {
      throw new UnprocessableEntityException({
        errors: result.errors.map(({ field, message }) => ({ field: field.join('.'), message })),
      } satisfies SpinErrorResponse);
    }
    return {
      slice: result.slice,
      label: result.label,
      code: result.code,
      endsAt: result.endsAt?.toISOString() ?? null,
      again: result.again,
    };
  }
}
