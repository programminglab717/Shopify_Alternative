import { INPUT_LIMITS, InputChecker, shopProfile, type FieldError } from '@hatti/api';
import { Database } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import {
  SIGN_UP_LIMITS,
  signUpsPath,
  type SignUpErrorResponse,
  type SignUpResponse,
} from '@hatti/storefront-api';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { CONSENT_LIMITS, recordConsentChanges, type ConsentChange } from './consent.js';
import { marketingWording } from './consent-words.js';
import { findOrCreateCustomerIn } from './customer.service.js';
import { CustomerEvents, type CustomerUpdatedPayload } from './events.js';
import { customers } from './schema.js';

/** What a sign-up through the online store's form gives (ADR-189), as its fields were posted. */
export interface SignUpInput {
  /** A Pakistani mobile number, as typed. */
  phone?: string | null;
  /** Tags for the customer, comma-separated, as Shopify's `contact[tags]` has them. */
  tags?: string | null;
  /** The words the form showed beside it; the platform's for WhatsApp, naming the shop, if none. */
  consent?: string | null;
}

export type SignUpOutcome =
  { ok: true; created: boolean; subscribed: boolean } | { ok: false; errors: FieldError[] };

/**
 * Shoppers signing up for a shop's news and offers through its online store's form (CUS-04,
 * ADR-189), as Shopify's customer form posts it.
 */
@Injectable()
export class SignUpService {
  constructor(private readonly db: Database) {}

  /**
   * Signs the shopper with `input.phone` up for the shop's news and offers on WhatsApp: the
   * customer with the number, made from it if it is new, subscribed from the storefront, by the
   * system, in the words the form showed, where it is their main number, which the shop's
   * messages go to; the form's tags added to theirs while they have room. A customer already
   * subscribed stays so, and one who said no before is subscribed again, as they now ask.
   */
  async signUp(shopId: string, input: SignUpInput): Promise<SignUpOutcome> {
    const check = new InputChecker();
    const phone = check.mobile(['phone'], input.phone, { required: true });
    const tags = check.tags(['tags'], (input.tags ?? '').split(','));
    if (tags.length > SIGN_UP_LIMITS.tags) {
      check.addMessage(['tags'], 'TOO_MANY', `A form gives ${SIGN_UP_LIMITS.tags} tags at most`);
    }
    const consent = check.text(['consent'], input.consent, { max: CONSENT_LIMITS.wording });
    if (!check.ok || !phone) return { ok: false, errors: check.errors };

    return this.db.tenant(shopId, async (tx) => {
      const found = await findOrCreateCustomerIn(
        tx,
        shopId,
        { phone, name: null, email: null },
        'storefront',
      );
      const [customer] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.shopId, shopId), eq(customers.id, found.id)))
        .for('update');
      if (!customer) throw new Error(`Customer ${found.id} went while signing up`);
      const changes: ConsentChange[] =
        customer.phone === phone
          ? [
              {
                field: [],
                channel: 'whatsapp',
                state: 'subscribed',
                source: 'storefront',
                wording:
                  consent ?? marketingWording((await shopProfile(tx, shopId)).name, 'whatsapp'),
                collectedAt: null,
              },
            ]
          : [];
      const version = customer.version + 1;
      const { set, changed } = await recordConsentChanges(
        tx,
        shopId,
        customer,
        changes,
        'system',
        version,
      );
      // The form's tags, as a customer's are kept: each once, whatever its letter case.
      const kept = new Set(customer.tags.map((tag) => tag.toLowerCase()));
      const added = tags
        .filter((tag) => !kept.has(tag.toLowerCase()))
        .slice(0, Math.max(INPUT_LIMITS.tags - customer.tags.length, 0));
      if (changed.length === 0 && added.length === 0) {
        return { ok: true, created: found.created, subscribed: false };
      }
      await tx
        .update(customers)
        .set({
          ...set,
          ...(added.length > 0 && { tags: [...customer.tags, ...added] }),
          version: sql`${customers.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(customers.shopId, shopId), eq(customers.id, customer.id)));
      if (added.length > 0) {
        await appendEvent<CustomerUpdatedPayload>(tx, shopId, {
          type: CustomerEvents.CustomerUpdated,
          aggregateType: 'customer',
          aggregateId: customer.id,
          payload: { changed: ['tags'], version },
        });
      }
      return { ok: true, created: found.created, subscribed: changed.length > 0 };
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Sign-ups through the online store's form, as storefronts send them on (ADR-189):
 * `POST /storefront/shops/{shop}/sign-ups` with the form's `phone`, `tags` and `consent`. 422
 * says what was wrong with them. The host application checks the storefront key before any of
 * this runs.
 */
@Controller(signUpsPath(':shopId').slice(1))
export class SignUpController {
  constructor(private readonly signUps: SignUpService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async signUp(@Param('shopId') shopId: string, @Body() body: unknown): Promise<SignUpResponse> {
    if (!UUID.test(shopId)) throw new NotFoundException();
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : null);
    const result = await this.signUps.signUp(shopId, {
      phone: text('phone'),
      tags: text('tags'),
      consent: text('consent'),
    });
    if (!result.ok) {
      throw new UnprocessableEntityException({
        errors: result.errors.map(({ field, message }) => ({ field: field.join('.'), message })),
      } satisfies SignUpErrorResponse);
    }
    return { created: result.created, subscribed: result.subscribed };
  }
}
