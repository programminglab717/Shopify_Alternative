import type { Db } from '@hatti/db';
import { sql } from 'drizzle-orm';
import { expertEnquiryEmail } from './account-emails.js';
import { suppressed } from './email-feedback.js';
import { AuthError } from './errors.js';
import type { AccountEmails } from './identity.service.js';

// Experts (PRT-03, ADR-855): Hatti's partners offer shops their services, from setting a store up
// to photographing its products, and a shop's owner or a manager finds one and sends an enquiry.
// A profile shows once Hatti has looked at it; an enquiry is the expert's to read on their
// partner page, and is emailed to them, with the address of who sent it to answer.

export const EXPERT_SERVICES = [
  'setup',
  'design',
  'photography',
  'ads',
  'migration',
  'apps',
  'content',
] as const;
export type ExpertService = (typeof EXPERT_SERVICES)[number];

export const EXPERT_LIMITS = {
  headline: 120,
  about: 2000,
  cities: 10,
  city: 40,
  message: 2000,
  /** Paisa: Rs 1,000,000. */
  startingPrice: 100_000_000n,
  /** Enquiries one person sends a day, and to one expert. */
  enquiriesPerDay: 10,
  enquiriesPerExpertPerDay: 1,
  /** A review's words (ADR-917), and the reviews an expert's page shows. */
  review: 1000,
  reviewsShown: 20,
} as const;

/** The roles that hire experts for a shop: owners and managers. */
const HIRERS = new Set(['owner', 'manager']);

export interface ExpertProfileInput {
  headline: string;
  about?: string | null;
  services: readonly string[];
  cities?: readonly string[] | null;
  languages: readonly string[];
  /** Paisa; nothing to say "ask". */
  startingPrice?: bigint | null;
}

export interface ExpertRecord {
  partnerId: string;
  businessName: string;
  website: string | null;
  headline: string;
  about: string;
  services: ExpertService[];
  cities: string[];
  languages: ('en' | 'ur')[];
  startingPrice: bigint;
  listed: boolean;
  /** Whether they hold Hatti's certificate, still good (ADR-858). */
  certified: boolean;
  /** Their shops' ratings out of five (ADR-917): the average to one place; null for none. */
  rating: { average: number | null; count: number };
  updatedAt: Date;
}

/** A shop's review of an expert it hired (ADR-917). */
export interface ExpertReviewRecord {
  shopName: string;
  rating: number;
  body: string;
  updatedAt: Date;
}

export interface EnquiryRecord {
  id: string;
  shop: { id: string; name: string; handle: string };
  sender: { name: string; email: string | null };
  service: ExpertService;
  message: string;
  createdAt: Date;
}

type ExpertRow = {
  partner_id: string;
  business_name: string;
  website: string | null;
  headline: string;
  about: string;
  services: ExpertService[];
  cities: string[];
  languages: ('en' | 'ur')[];
  starting_price: string;
  listed_at: Date | string | null;
  certified: boolean;
  rating_average: string | null;
  rating_count: number;
  updated_at: Date | string;
};

const COLUMNS = sql`e.partner_id, p.business_name, p.website, e.headline, e.about, e.services,
                    e.cities, e.languages, e.starting_price::text, e.listed_at, e.updated_at,
                    EXISTS (SELECT 1 FROM identity.partner_certificates c
                             WHERE c.partner_id = e.partner_id AND c.expires_at > now())
                      AS certified,
                    (SELECT round(avg(r.rating), 1)::text FROM identity.expert_reviews r
                      WHERE r.partner_id = e.partner_id) AS rating_average,
                    (SELECT count(*)::int FROM identity.expert_reviews r
                      WHERE r.partner_id = e.partner_id) AS rating_count`;

const toRecord = (row: ExpertRow): ExpertRecord => ({
  partnerId: row.partner_id,
  businessName: row.business_name,
  website: row.website,
  headline: row.headline,
  about: row.about,
  services: EXPERT_SERVICES.filter((service) => row.services.includes(service)),
  cities: row.cities,
  languages: row.languages,
  startingPrice: BigInt(row.starting_price),
  listed: row.listed_at !== null,
  certified: row.certified,
  rating: {
    average: row.rating_average === null ? null : Number(row.rating_average),
    count: row.rating_count,
  },
  updatedAt: new Date(row.updated_at),
});

const invalid = (message: string) => new AuthError('INVALID_INPUT', 422, message);

const isService = (value: string): value is ExpertService =>
  (EXPERT_SERVICES as readonly string[]).includes(value);

export class ExpertsService {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly emails: AccountEmails | null;

  constructor(options: { db: Db; now?: () => Date; emails?: AccountEmails | null }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.emails = options.emails ?? null;
  }

  /** The partner's own profile; null while they have none. */
  async profile(userId: string): Promise<ExpertRecord | null> {
    return (await this.#find(sql`e.partner_id = ${userId}`))[0] ?? null;
  }

  /**
   * Saves the partner's profile: shown to shops once Hatti has looked at it, and as it changes
   * after that.
   */
  async save(userId: string, input: ExpertProfileInput): Promise<ExpertRecord> {
    const { rows: partner } = await this.db.execute(sql`
      SELECT 1 FROM identity.partners WHERE user_id = ${userId}`);
    if (partner.length === 0) {
      throw new AuthError('NOT_PARTNER', 403, "Join Hatti's partner programme first");
    }
    const headline = input.headline.trim();
    if (!headline || headline.length > EXPERT_LIMITS.headline) {
      throw invalid(`Say what you do in ${EXPERT_LIMITS.headline} characters at most`);
    }
    const about = (input.about ?? '').trim();
    if (about.length > EXPERT_LIMITS.about) {
      throw invalid(`Tell about your work in ${EXPERT_LIMITS.about} characters at most`);
    }
    const services = EXPERT_SERVICES.filter((service) => input.services.includes(service));
    if (services.length === 0 || input.services.some((service) => !isService(service))) {
      throw invalid(`Choose what you offer of ${EXPERT_SERVICES.join(', ')}`);
    }
    const cities = [...new Set((input.cities ?? []).map((city) => city.trim()).filter(Boolean))];
    if (
      cities.length > EXPERT_LIMITS.cities ||
      cities.some((city) => city.length > EXPERT_LIMITS.city)
    ) {
      throw invalid(
        `Name ${EXPERT_LIMITS.cities} cities at most, each in ${EXPERT_LIMITS.city} characters`,
      );
    }
    const languages = (['en', 'ur'] as const).filter((language) =>
      input.languages.includes(language),
    );
    if (languages.length === 0) throw invalid('Say which languages you work in: en, ur');
    const startingPrice = input.startingPrice ?? 0n;
    if (
      startingPrice < 0n ||
      startingPrice > EXPERT_LIMITS.startingPrice ||
      startingPrice % 100n !== 0n
    ) {
      throw invalid('Give a starting price in whole rupees, up to Rs 1,000,000');
    }
    await this.db.execute(sql`
      INSERT INTO identity.expert_profiles
             (partner_id, headline, about, services, cities, languages, starting_price)
      VALUES (${userId}, ${headline}, ${about}, ${sql.param(services)}::text[],
              ${sql.param(cities)}::text[], ${sql.param(languages)}::text[], ${startingPrice})
      ON CONFLICT (partner_id) DO UPDATE
         SET headline = EXCLUDED.headline, about = EXCLUDED.about, services = EXCLUDED.services,
             cities = EXCLUDED.cities, languages = EXCLUDED.languages,
             starting_price = EXCLUDED.starting_price, updated_at = now()`);
    return (await this.profile(userId))!;
  }

  /**
   * The experts Hatti listed, those offering `service`, working in `city` and `language` where
   * asked; those whose profiles changed latest first.
   */
  async directory(
    filter: { service?: string | null; city?: string | null; language?: string | null } = {},
  ): Promise<ExpertRecord[]> {
    const city = filter.city?.trim().toLowerCase();
    return this.#find(
      sql`e.listed_at IS NOT NULL
      ${filter.service ? sql`AND ${filter.service} = ANY(e.services)` : sql``}
      ${filter.language ? sql`AND ${filter.language} = ANY(e.languages)` : sql``}
      ${city ? sql`AND EXISTS (SELECT 1 FROM unnest(e.cities) c WHERE lower(c) = ${city})` : sql``}`,
      true,
    );
  }

  /**
   * Sends the expert `partnerId` an enquiry from the signed-in owner or manager of `shopId`,
   * about `service`: kept for the expert, and emailed to them. Ten a day at most, one a day to
   * each expert.
   */
  async enquire(
    userId: string,
    input: { partnerId: string; shopId: string; service: string; message: string },
  ): Promise<{ id: string }> {
    const message = input.message.trim();
    if (!message || message.length > EXPERT_LIMITS.message) {
      throw invalid(`Write your message in ${EXPERT_LIMITS.message} characters at most`);
    }
    if (!isService(input.service)) throw invalid('Say what you need of what the expert offers');
    const { rows: members } = await this.db.execute<{ role: string; shop_name: string }>(sql`
      SELECT m.role, s.name AS shop_name FROM identity.memberships m
        JOIN control.shops s ON s.id = m.shop_id AND s.status = 'active'
       WHERE m.user_id = ${userId} AND m.shop_id = ${input.shopId} AND m.status = 'active'`);
    const member = members[0];
    if (!member || !HIRERS.has(member.role)) {
      throw new AuthError('FORBIDDEN', 403, "Only the shop's owner or a manager hires experts");
    }
    const experts = await this.#find(
      sql`e.partner_id = ${input.partnerId} AND e.listed_at IS NOT NULL`,
    );
    const expert = experts[0];
    if (!expert || expert.partnerId === userId)
      throw new AuthError('NOT_FOUND', 404, 'No such expert');
    if (!expert.services.includes(input.service)) {
      throw invalid("The expert doesn't offer that");
    }
    const since = new Date(this.now().getTime() - 24 * 3_600_000).toISOString();
    const { rows: sent } = await this.db.execute<{ total: number; theirs: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE partner_id = ${input.partnerId})::int AS theirs
        FROM identity.expert_enquiries
       WHERE user_id = ${userId} AND created_at > ${since}`);
    if (
      (sent[0]?.total ?? 0) >= EXPERT_LIMITS.enquiriesPerDay ||
      (sent[0]?.theirs ?? 0) >= EXPERT_LIMITS.enquiriesPerExpertPerDay
    ) {
      throw new AuthError(
        'RATE_LIMITED',
        429,
        'You have sent enough enquiries for today: try again tomorrow',
      );
    }
    const { rows } = await this.db.execute<{ id: string }>(sql`
      INSERT INTO identity.expert_enquiries (partner_id, shop_id, user_id, service, message)
      VALUES (${input.partnerId}, ${input.shopId}, ${userId}, ${input.service}, ${message})
      RETURNING id`);
    await this.#email(expert.partnerId, userId, member.shop_name, input.service);
    return { id: rows[0]!.id };
  }

  /** The enquiries shops sent the partner, the latest first, of the last 90 days. */
  async enquiries(userId: string): Promise<EnquiryRecord[]> {
    const since = new Date(this.now().getTime() - 90 * 24 * 3_600_000).toISOString();
    const { rows } = await this.db.execute<{
      id: string;
      shop_id: string;
      shop_name: string;
      handle: string;
      sender_name: string;
      sender_email: string | null;
      service: ExpertService;
      message: string;
      created_at: Date | string;
    }>(sql`
      SELECT q.id, q.shop_id, s.name AS shop_name, s.handle, u.name AS sender_name,
             u.email AS sender_email, q.service, q.message, q.created_at
        FROM identity.expert_enquiries q
        JOIN control.shops s ON s.id = q.shop_id
        JOIN identity.users u ON u.id = q.user_id
       WHERE q.partner_id = ${userId} AND q.created_at > ${since}
       ORDER BY q.created_at DESC, q.id DESC
       LIMIT 200`);
    return rows.map((row) => ({
      id: row.id,
      shop: { id: row.shop_id, name: row.shop_name, handle: row.handle },
      sender: { name: row.sender_name, email: row.sender_email },
      service: row.service,
      message: row.message,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * The reviews of expert `partnerId`, the latest first, up to {@link EXPERT_LIMITS.reviewsShown}:
   * each with the shop's name, as shops and the expert read them (ADR-917).
   */
  async reviewsOf(partnerId: string): Promise<ExpertReviewRecord[]> {
    const { rows } = await this.db.execute<{
      shop_name: string;
      rating: number;
      body: string;
      updated_at: Date | string;
    }>(sql`
      SELECT s.name AS shop_name, r.rating, r.body, r.updated_at
        FROM identity.expert_reviews r
        JOIN control.shops s ON s.id = r.shop_id
       WHERE r.partner_id = ${partnerId}
       ORDER BY r.updated_at DESC, r.shop_id
       LIMIT ${EXPERT_LIMITS.reviewsShown}`);
    return rows.map((row) => ({
      shopName: row.shop_name,
      rating: row.rating,
      body: row.body,
      updatedAt: new Date(row.updated_at),
    }));
  }

  /**
   * Whether the signed-in member may review expert `partnerId` for `shopId`, and the shop's
   * review if it wrote one: an owner or a manager of a shop that gave the expert access to it
   * (ADR-488), as having hired them.
   */
  async reviewOfShop(
    userId: string,
    partnerId: string,
    shopId: string,
  ): Promise<{ allowed: boolean; review: { rating: number; body: string } | null }> {
    const { rows } = await this.db.execute<{
      role: string;
      hired: boolean;
      rating: number | null;
      body: string | null;
    }>(sql`
      SELECT m.role,
             EXISTS (SELECT 1 FROM identity.access_requests a
                      WHERE a.shop_id = m.shop_id AND a.user_id = ${partnerId}
                        AND a.status = 'approved') AS hired,
             r.rating, r.body
        FROM identity.memberships m
        JOIN control.shops s ON s.id = m.shop_id AND s.status = 'active'
        LEFT JOIN identity.expert_reviews r
               ON r.partner_id = ${partnerId} AND r.shop_id = m.shop_id
       WHERE m.user_id = ${userId} AND m.shop_id = ${shopId} AND m.status = 'active'`);
    const row = rows[0];
    return {
      allowed: !!row && HIRERS.has(row.role) && row.hired && partnerId !== userId,
      review: row && row.rating !== null ? { rating: row.rating, body: row.body ?? '' } : null,
    };
  }

  /**
   * Rates expert `partnerId` out of five for `shopId`, with words of how the work went or none,
   * by its owner or a manager, the shop having given the expert access to it: once a shop,
   * written again as it changes its mind.
   */
  async rate(
    userId: string,
    input: { partnerId: string; shopId: string; rating: number; body?: string | null },
  ): Promise<ExpertReviewRecord> {
    const body = input.body?.trim() ?? '';
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw invalid('Rate the expert from 1 to 5');
    }
    if (body.length > EXPERT_LIMITS.review) {
      throw invalid(`Write your review in ${EXPERT_LIMITS.review} characters at most`);
    }
    const expert = (await this.#find(sql`e.partner_id = ${input.partnerId}`))[0];
    if (!expert) throw new AuthError('NOT_FOUND', 404, 'No such expert');
    if (!(await this.reviewOfShop(userId, input.partnerId, input.shopId)).allowed) {
      throw new AuthError(
        'FORBIDDEN',
        403,
        "A shop's owner or a manager reviews an expert the shop gave access to",
      );
    }
    const { rows } = await this.db.execute<{ updated_at: Date | string; shop_name: string }>(sql`
      WITH kept AS (
        INSERT INTO identity.expert_reviews (partner_id, shop_id, user_id, rating, body)
        VALUES (${input.partnerId}, ${input.shopId}, ${userId}, ${input.rating}, ${body})
        ON CONFLICT (partner_id, shop_id) DO UPDATE
           SET user_id = excluded.user_id, rating = excluded.rating, body = excluded.body,
               updated_at = now()
        RETURNING shop_id, updated_at
      )
      SELECT kept.updated_at, s.name AS shop_name
        FROM kept JOIN control.shops s ON s.id = kept.shop_id`);
    return {
      shopName: rows[0]!.shop_name,
      rating: input.rating,
      body,
      updatedAt: new Date(rows[0]!.updated_at),
    };
  }

  /** For Hatti's review: every profile, those waiting first. */
  async all(): Promise<ExpertRecord[]> {
    return this.#find(sql`true`, false, sql`e.listed_at IS NOT NULL, e.updated_at`);
  }

  /** Hatti's review (ADR-855): the partner's profile listed for shops, or taken back. */
  async review(partnerId: string, listed: boolean): Promise<ExpertRecord | null> {
    await this.db.execute(sql`
      UPDATE identity.expert_profiles
         SET listed_at = ${listed ? sql`coalesce(listed_at, now())` : sql`NULL`}
       WHERE partner_id = ${partnerId}`);
    return this.profile(partnerId);
  }

  async #find(
    where: ReturnType<typeof sql>,
    latest = false,
    order: ReturnType<typeof sql> = latest ? sql`e.updated_at DESC` : sql`e.created_at`,
  ): Promise<ExpertRecord[]> {
    const { rows } = await this.db.execute<ExpertRow>(sql`
      SELECT ${COLUMNS} FROM identity.expert_profiles e
        JOIN identity.partners p ON p.user_id = e.partner_id
       WHERE ${where}
       ORDER BY ${order}, e.partner_id`);
    return rows.map(toRecord);
  }

  async #email(partnerId: string, senderId: string, shop: string, service: string): Promise<void> {
    if (!this.emails) return;
    const { rows } = await this.db.execute<{
      email: string | null;
      language: 'en' | 'ur';
      verified: boolean;
      sender: string;
    }>(sql`
      SELECT u.email, u.language, u.email_verified_at IS NOT NULL AS verified,
             (SELECT name FROM identity.users WHERE id = ${senderId}) AS sender
        FROM identity.users u
       WHERE u.id = ${partnerId} AND u.status = 'active'`);
    const to = rows[0];
    if (!to?.email || !to.verified || (await suppressed(this.db, to.email))) return;
    await this.emails.sender
      .send(
        expertEnquiryEmail({
          to: to.email,
          sender: to.sender,
          shop,
          service,
          link: `${this.emails.adminUrl.replace(/\/+$/, '')}/partners`,
          language: to.language,
        }),
      )
      .catch(() => false);
  }
}
