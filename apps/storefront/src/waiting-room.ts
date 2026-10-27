import { createHash, randomBytes } from 'node:crypto';
import { html, renderPage, say, type RenderedPage, type Words } from '@hatti/documents';
import type { ShopDoc, StorefrontKeys, WaitingRoomDoc } from '@hatti/storefront-data';
import type { Redis } from 'ioredis';
import { cookieOf } from './cart.js';

// A drop's waiting room (OS-17, ADR-822): while a drop with one is live, a shopper who comes is
// given a place in line, kept by a secret in a cookie of theirs and by its digest in Valkey, and
// let in once the room has let in as many as come before them: a minute's worth at the start,
// and a minute's more each minute. Until then, every page shows where they are, and asks again by
// itself. One internet address takes only so many places, as a bot would take many.

/** The cookie keeping a shopper's place: the drop's ID and a secret, which only the server reads. */
export const ROOM_COOKIE = 'hatti_line';

export const ROOM_LIMITS = {
  /** Places in one drop's line that one internet address takes. */
  placesPerAddress: 10,
  /** How often the waiting page asks again, at least; a few seconds more at random. */
  refreshSeconds: 20,
} as const;

/** How many of a room's line are let in by `now`: a minute's worth at its start, a minute's more each minute. */
export function admittedBy(room: WaitingRoomDoc, now: Date): number {
  const minutes = Math.floor((now.getTime() - Date.parse(room.startsAt)) / 60_000) + 1;
  return Math.max(0, minutes) * room.admitPerMinute;
}

/** What the room says of a shopper: in, waiting with so many ahead, or turned away. */
export type RoomAnswer =
  | { kind: 'in'; cookie: string | null }
  | { kind: 'waiting'; cookie: string | null; ahead: number; minutes: number }
  | { kind: 'refused' };

const digest = (text: string) => createHash('sha256').update(text).digest('base64url');

/** Shoppers' places in drops' lines, kept in Valkey (ADR-822). */
export class WaitingRooms {
  constructor(
    private readonly redis: Redis,
    private readonly keys: StorefrontKeys,
  ) {}

  /**
   * Where the shopper whose cookies are `cookies`, from `ip`, stands in `room` of `shopId` at
   * `now`: let in once their place is reached; given a place, and the cookie keeping it, when
   * they have none.
   */
  async enter(
    shopId: string,
    room: WaitingRoomDoc,
    cookies: string | undefined,
    ip: string,
    now: Date,
    options: { secure: boolean },
  ): Promise<RoomAnswer> {
    const base = this.keys.waitingRoom(shopId, room.dropId);
    const ttl = Math.max(60_000, Date.parse(room.endsAt) - now.getTime() + 3_600_000);
    const admitted = admittedBy(room, now);
    const kept = cookieOf(cookies, ROOM_COOKIE);
    const [dropId, secret] = kept?.split('.') ?? [];
    let place: number | null = null;
    let cookie: string | null = null;
    if (dropId === room.dropId && secret && /^[A-Za-z0-9_-]{22}$/.test(secret)) {
      const found = await this.redis.get(`${base}:t:${digest(secret)}`);
      place = found === null ? null : Number(found);
    }
    if (place === null) {
      const address = `${base}:ip:${digest(ip)}`;
      const taken = await this.redis.incr(address);
      if (taken === 1) await this.redis.pexpire(address, ttl);
      if (taken > ROOM_LIMITS.placesPerAddress) return { kind: 'refused' };
      place = await this.redis.incr(`${base}:n`);
      if (place === 1) await this.redis.pexpire(`${base}:n`, ttl);
      const fresh = randomBytes(16).toString('base64url');
      await this.redis.set(`${base}:t:${digest(fresh)}`, String(place), 'PX', ttl);
      cookie =
        `${ROOM_COOKIE}=${room.dropId}.${fresh}; Max-Age=${Math.ceil(ttl / 1000)}; Path=/; ` +
        `SameSite=Lax; HttpOnly${options.secure ? '; Secure' : ''}`;
    }
    if (place <= admitted) return { kind: 'in', cookie };
    const ahead = place - admitted;
    return { kind: 'waiting', cookie, ahead, minutes: Math.ceil(ahead / room.admitPerMinute) };
  }
}

const WORDS = {
  title: { en: "You're in line", ur: 'آپ قطار میں ہیں' },
  busy: {
    en: 'So many shoppers came at once that the shop lets them in a few at a time, in the order they came.',
    ur: 'ایک ساتھ اتنے خریدار آئے ہیں کہ دکان انہیں آنے کی ترتیب سے تھوڑے تھوڑے کر کے اندر آنے دیتی ہے۔',
  },
  keepOpen: {
    en: 'Keep this page open: it lets you in by itself. Coming back later keeps your place.',
    ur: 'یہ صفحہ کھلا رکھیں: یہ آپ کو خود اندر لے جائے گا۔ بعد میں واپس آنے پر بھی آپ کی جگہ برقرار رہے گی۔',
  },
  refused: {
    en: 'Too many places in line came from your internet connection. Try again later.',
    ur: 'آپ کے انٹرنیٹ کنکشن سے قطار میں بہت سی جگہیں لی گئیں۔ کچھ دیر بعد دوبارہ کوشش کریں۔',
  },
} satisfies Record<string, Words>;

/**
 * The page a shopper waiting in a drop's line sees in place of the shop's (ADR-822): the shop, the
 * drop, about how many are ahead of them and how long that is, in English and Urdu.
 */
export function waitingPage(
  shop: ShopDoc,
  room: WaitingRoomDoc,
  answer: Extract<RoomAnswer, { kind: 'waiting' } | { kind: 'refused' }>,
): RenderedPage {
  const logo = shop.brand?.logo ?? null;
  const where: Words =
    answer.kind === 'waiting'
      ? {
          en: `About ${answer.ahead.toLocaleString('en')} ahead of you: around ${answer.minutes} ${
            answer.minutes === 1 ? 'minute' : 'minutes'
          }.`,
          ur: `آپ سے آگے تقریباً ${answer.ahead.toLocaleString('en')}: لگ بھگ ${answer.minutes} منٹ۔`,
        }
      : WORDS.refused;
  return renderPage({
    title: `${WORDS.title.en} · ${shop.name}`,
    images: logo ? [logo] : [],
    body: html`
      ${
        logo
          ? html`<p class="shop"><img class="logo" src="${logo}" alt="${shop.name}" /></p>`
          : html`<p class="shop"><bdi>${shop.name}</bdi></p>`
      }
      <h1 class="title stack">${say('bilingual', WORDS.title)}</h1>
      <p class="center">
        <strong><bdi>${room.name}</bdi></strong>
      </p>
      <div class="text center muted">${say('bilingual', WORDS.busy)}</div>
      <div class="text center">${say('bilingual', where)}</div>
      ${
        answer.kind === 'waiting' &&
        html`<div class="text center muted">${say('bilingual', WORDS.keepOpen)}</div>`
      }
    `,
  });
}
