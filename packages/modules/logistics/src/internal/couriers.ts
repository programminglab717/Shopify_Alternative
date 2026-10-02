// Couriers' APIs behind one interface (SHP-01, ADR-149): booking a parcel, following it and
// cancelling its booking. Shops connect their own accounts, so each call carries the account's
// credentials; the courier remits cash on delivery to the shop directly.

/**
 * Where a parcel is, as Hatti reads what its courier says: booked and waiting to be picked up, on
 * its way, out with a rider, a delivery tried and failed, delivered, on its way back, back with
 * the shop, lost, or its booking cancelled.
 */
export const COURIER_PARCEL_STATUSES = [
  'booked',
  'in_transit',
  'out_for_delivery',
  'attempted',
  'delivered',
  'returning',
  'returned',
  'lost',
  'cancelled',
] as const;
export type CourierParcelStatusValue = (typeof COURIER_PARCEL_STATUSES)[number];

/** A credential a courier's API asks for, as staff copy it from the courier's portal. */
export interface CourierCredentialField {
  key: string;
  label: string;
}

/** A courier shops book with: its key, its name, and what connecting an account asks for. */
export interface CourierInfo {
  /** "postex". */
  courier: string;
  /** "PostEx", as parcels' tracking names it. */
  name: string;
  credentials: readonly CourierCredentialField[];
  /** What the courier calls its code for the shop's pickup address; null when it has none. */
  pickupCode: string | null;
  /** Books nothing with any courier: for development and tests, never in production. */
  test: boolean;
}

/** An account's credentials, opened, by {@link CourierCredentialField.key}. */
export type CourierCredentials = Readonly<Record<string, string>>;

/** The parcel a courier is asked to book, as its order says it. */
export interface CourierShipment {
  /** The order's name, "#1043": the courier's reference for it. */
  reference: string;
  customerName: string;
  /** The customer's mobile number as couriers write it: 03001234567. */
  customerPhone: string;
  /** The house and street, the area and a landmark. */
  address: string;
  /** The city as the courier names it. */
  city: string;
  /** Minor units: the cash to collect at the door; 0 when nothing is owed. */
  codAmount: bigint;
  /** Pieces in the parcel. */
  pieces: number;
  /** What is in it: "Kurta - Red x 2, Dupatta". */
  contents: string;
  weightGrams: number | null;
  /** The courier's code for where it picks the parcel up; its account's default if null. */
  pickupCode: string | null;
}

/** What a courier answered: what was asked, or why not, and whether trying again may help. */
export type CourierResult<T> =
  { ok: true; value: T } | { ok: false; retry: boolean; message: string };

/** A parcel's status as its courier says it, such as "Out For Delivery". */
export interface CourierTracking {
  trackingNumber: string;
  status: string;
}

/** A courier's API (docs/architecture/06-orders-fulfillment-logistics.md §5.1). */
export interface CourierAdapter {
  readonly info: CourierInfo;
  /** Books the parcel: its tracking number. */
  book(
    credentials: CourierCredentials,
    shipment: CourierShipment,
  ): Promise<CourierResult<{ trackingNumber: string }>>;
  /** The parcels' statuses; those the courier says nothing of are left out. */
  track(
    credentials: CourierCredentials,
    trackingNumbers: readonly string[],
  ): Promise<CourierResult<CourierTracking[]>>;
  /** Cancels the parcel's booking, before it is picked up. */
  cancel(credentials: CourierCredentials, trackingNumber: string): Promise<CourierResult<null>>;
}

/** The couriers shops can book with, by key. */
export class Couriers {
  readonly #adapters: ReadonlyMap<string, CourierAdapter>;

  constructor(adapters: readonly CourierAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.info.courier, adapter]));
  }

  /** The courier `courier`'s adapter; null if shops cannot book with it here. */
  of(courier: string): CourierAdapter | null {
    return this.#adapters.get(courier) ?? null;
  }

  /** What each courier is and asks for, by name. */
  get list(): CourierInfo[] {
    return [...this.#adapters.values()]
      .map((adapter) => adapter.info)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * What a courier's raw status means, when no mapping says (ADR-149): a status written as Hatti
 * names its own, such as "Out For Delivery" or "delivered".
 */
export function plainStatusOf(raw: string): CourierParcelStatusValue | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (COURIER_PARCEL_STATUSES as readonly string[]).includes(key)
    ? (key as CourierParcelStatusValue)
    : null;
}

/** PostEx's merchant API. */
export const POSTEX_API_URL = 'https://api.postex.pk/services/integration/api/order';

export interface PostExOptions {
  /** {@link POSTEX_API_URL}, unless a test says otherwise. */
  baseUrl?: string;
  /** How long a request may take; fifteen seconds unless given. */
  timeoutMs?: number;
}

/** What PostEx answers every request with. */
interface PostExAnswer {
  statusCode?: string | number;
  statusMessage?: string;
  dist?: {
    trackingNumber?: string;
    transactionStatus?: string;
    transactionStatusHistory?: { transactionStatusMessage?: string }[];
  } | null;
}

/**
 * PostEx (https://api.postex.pk): a booking is an order of PostEx's, its tracking number PostEx's
 * own; tracking asks for each parcel in turn. Its token goes in a header, never in an address.
 */
export class PostExCourier implements CourierAdapter {
  readonly info: CourierInfo = {
    courier: 'postex',
    name: 'PostEx',
    credentials: [{ key: 'token', label: 'API token' }],
    pickupCode: 'Pickup address code',
    test: false,
  };

  constructor(private readonly options: PostExOptions = {}) {}

  async book(
    credentials: CourierCredentials,
    shipment: CourierShipment,
  ): Promise<CourierResult<{ trackingNumber: string }>> {
    const { answer } = await this.#call(credentials, 'POST', 'v3/create-order', {
      orderRefNumber: shipment.reference,
      // Whole rupees, as riders collect them: paisa round up.
      invoicePayment: Number((shipment.codAmount + 99n) / 100n),
      orderDetail: shipment.contents,
      customerName: shipment.customerName,
      customerPhone: shipment.customerPhone,
      deliveryAddress: shipment.address,
      cityName: shipment.city,
      // One airway bill for the parcel.
      invoiceDivision: 1,
      items: shipment.pieces,
      orderType: 'Normal',
      ...(shipment.pickupCode ? { pickupAddressCode: shipment.pickupCode } : {}),
    });
    if (!answer.ok) return answer;
    const trackingNumber = answer.value.dist?.trackingNumber;
    if (typeof trackingNumber !== 'string' || trackingNumber.trim() === '') {
      return {
        ok: false,
        retry: false,
        message: 'PostEx booked the order without a tracking number',
      };
    }
    return { ok: true, value: { trackingNumber: trackingNumber.trim() } };
  }

  async track(
    credentials: CourierCredentials,
    trackingNumbers: readonly string[],
  ): Promise<CourierResult<CourierTracking[]>> {
    const tracked: CourierTracking[] = [];
    for (const trackingNumber of trackingNumbers) {
      const { answer, status } = await this.#call(
        credentials,
        'GET',
        `v1/track-order/${encodeURIComponent(trackingNumber)}`,
      );
      if (!answer.ok) {
        // PostEx not answering, or refusing the account, stops the round; a parcel it does not
        // know is left out.
        if (answer.retry || status === 401 || status === 403) return answer;
        continue;
      }
      const dist = answer.value.dist;
      const said =
        dist?.transactionStatus ?? dist?.transactionStatusHistory?.at(-1)?.transactionStatusMessage;
      if (typeof said === 'string' && said.trim() !== '') {
        tracked.push({ trackingNumber, status: said.trim().slice(0, 200) });
      }
    }
    return { ok: true, value: tracked };
  }

  async cancel(
    credentials: CourierCredentials,
    trackingNumber: string,
  ): Promise<CourierResult<null>> {
    const { answer } = await this.#call(credentials, 'PUT', 'v1/cancel-order', { trackingNumber });
    return answer.ok ? { ok: true, value: null } : answer;
  }

  async #call(
    credentials: CourierCredentials,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ answer: CourierResult<PostExAnswer>; status: number }> {
    const base = (this.options.baseUrl ?? POSTEX_API_URL).replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetch(`${base}/${path}`, {
        method,
        headers: {
          token: credentials.token ?? '',
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        answer: {
          ok: false,
          retry: true,
          message: `PostEx could not be reached: ${(error as Error).message}`.slice(0, 1_000),
        },
        status: 0,
      };
    }
    const json = (await response.json().catch(() => null)) as PostExAnswer | null;
    // PostEx says how a request went in its answer too, and may say otherwise than HTTP does.
    const code = Number(json?.statusCode ?? response.status);
    if (response.ok && code === 200) {
      return { answer: { ok: true, value: json ?? {} }, status: response.status };
    }
    const said = typeof json?.statusMessage === 'string' ? json.statusMessage.trim() : '';
    return {
      answer: {
        ok: false,
        retry: response.status >= 500 || response.status === 429 || code >= 500 || code === 429,
        message: `PostEx: ${said || `it answered ${response.status}`}`.slice(0, 1_000),
      },
      status: response.ok ? code : response.status,
    };
  }
}

/** Leopards' merchant API; its staging API is at merchantapistaging.leopardscourier.com. */
export const LEOPARDS_API_URL = 'https://merchantapi.leopardscourier.com/api';

export interface LeopardsOptions {
  /** {@link LEOPARDS_API_URL}, unless a test or Leopards' staging says otherwise. */
  baseUrl?: string;
  /** How long a request may take; fifteen seconds unless given. */
  timeoutMs?: number;
  /** How long Leopards' list of cities is kept before it is asked for again: a day unless given. */
  citiesTtlMs?: number;
}

/** What Leopards answers every request with: `status` 1 when it did what was asked, else 0. */
interface LeopardsAnswer {
  status?: number | string;
  error?: unknown;
  track_number?: string;
  packet_list?: LeopardsPacket[];
  city_list?: LeopardsCity[];
}

interface LeopardsPacket {
  track_number?: string;
  booked_packet_cn?: string;
  booked_packet_status?: string;
  'Tracking Detail'?: { Status?: string }[];
}

interface LeopardsCity {
  id?: number | string;
  name?: string;
  allow_as_destination?: boolean | number | string;
}

/** What a parcel without a weight is booked as: Leopards' first half kilo. */
const LEOPARDS_DEFAULT_GRAMS = 500;

/** Tracking numbers asked about in one request. */
const LEOPARDS_TRACK_BATCH = 50;

/**
 * Leopards (https://merchantapi.leopardscourier.com): the account's key and password go in each
 * request's body, never in an address. A booking names its city by Leopards' ID for it, from
 * Leopards' list of cities, kept a day; the shipper and the city it ships from are the account's
 * own, or those of the shipper ID given as the pickup code. Tracking asks about fifty parcels at a
 * time.
 */
export class LeopardsCourier implements CourierAdapter {
  readonly info: CourierInfo = {
    courier: 'leopards',
    name: 'Leopards',
    credentials: [
      { key: 'apiKey', label: 'API key' },
      { key: 'apiPassword', label: 'API password' },
    ],
    pickupCode: 'Shipper ID',
    test: false,
  };

  /** Leopards' cities, by {@link cityKey}, with when they were asked for. */
  #cities: { at: number; ids: ReadonlyMap<string, number | string> } | null = null;

  constructor(private readonly options: LeopardsOptions = {}) {}

  async book(
    credentials: CourierCredentials,
    shipment: CourierShipment,
  ): Promise<CourierResult<{ trackingNumber: string }>> {
    const city = await this.#cityId(credentials, shipment.city);
    if (!city.ok) return city;
    const shipper = shipment.pickupCode?.trim() ?? '';
    const answer = await this.#call(credentials, 'bookPacket', {
      booked_packet_weight:
        shipment.weightGrams !== null && shipment.weightGrams > 0
          ? Math.ceil(shipment.weightGrams)
          : LEOPARDS_DEFAULT_GRAMS,
      booked_packet_no_piece: shipment.pieces,
      // Whole rupees, as riders collect them: paisa round up.
      booked_packet_collect_amount: Number((shipment.codAmount + 99n) / 100n),
      booked_packet_order_id: shipment.reference,
      origin_city: 'self',
      destination_city: city.value,
      ...(shipper === '' ? {} : { shipment_id: /^\d+$/.test(shipper) ? Number(shipper) : shipper }),
      shipment_name_eng: 'self',
      shipment_email: 'self',
      shipment_phone: 'self',
      shipment_address: 'self',
      consignment_name_eng: shipment.customerName,
      consignment_phone: shipment.customerPhone,
      consignment_address: shipment.address,
      // Printed on its airway bill: what is in the parcel.
      special_instructions: shipment.contents,
    });
    if (!answer.ok) return answer;
    const trackingNumber = answer.value.track_number;
    if (typeof trackingNumber !== 'string' || trackingNumber.trim() === '') {
      return {
        ok: false,
        retry: false,
        message: 'Leopards booked the parcel without a tracking number',
      };
    }
    return { ok: true, value: { trackingNumber: trackingNumber.trim() } };
  }

  async track(
    credentials: CourierCredentials,
    trackingNumbers: readonly string[],
  ): Promise<CourierResult<CourierTracking[]>> {
    const tracked: CourierTracking[] = [];
    const ask = (numbers: readonly string[]) =>
      this.#call(credentials, 'trackBookedPacket', { track_numbers: numbers.join(',') });
    const keep = (numbers: readonly string[], packets: readonly LeopardsPacket[]) => {
      const wanted = new Set(numbers);
      for (const packet of packets) {
        const trackingNumber = (packet.track_number ?? packet.booked_packet_cn ?? '').trim();
        const said =
          packet.booked_packet_status ?? packet['Tracking Detail']?.at(-1)?.Status ?? null;
        if (wanted.has(trackingNumber) && typeof said === 'string' && said.trim() !== '') {
          tracked.push({ trackingNumber, status: said.trim().slice(0, 200) });
        }
      }
    };
    for (let start = 0; start < trackingNumbers.length; start += LEOPARDS_TRACK_BATCH) {
      const batch = trackingNumbers.slice(start, start + LEOPARDS_TRACK_BATCH);
      const answer = await ask(batch);
      if (answer.ok) {
        keep(batch, answer.value.packet_list ?? []);
        continue;
      }
      if (answer.retry || batch.length === 1) return answer;
      // One parcel Leopards does not know may refuse the batch: each is asked about alone, and
      // those it refuses are left out. Refusing them all is the account's doing, which stops the
      // round.
      let refused = 0;
      for (const trackingNumber of batch) {
        const alone = await ask([trackingNumber]);
        if (alone.ok) keep([trackingNumber], alone.value.packet_list ?? []);
        else if (alone.retry) return alone;
        else refused += 1;
      }
      if (refused === batch.length) return answer;
    }
    return { ok: true, value: tracked };
  }

  async cancel(
    credentials: CourierCredentials,
    trackingNumber: string,
  ): Promise<CourierResult<null>> {
    const answer = await this.#call(credentials, 'cancelBookedPackets', {
      cn_numbers: trackingNumber,
    });
    return answer.ok ? { ok: true, value: null } : answer;
  }

  /** Leopards' ID for `city`, from its list of cities, which is asked for once a day. */
  async #cityId(
    credentials: CourierCredentials,
    city: string,
  ): Promise<CourierResult<number | string>> {
    const ttl = this.options.citiesTtlMs ?? 24 * 3_600_000;
    if (!this.#cities || Date.now() - this.#cities.at > ttl) {
      const answer = await this.#call(credentials, 'getAllCities', {});
      if (!answer.ok) return answer;
      const ids = new Map<string, number | string>();
      for (const each of answer.value.city_list ?? []) {
        const key = cityKey(each.name ?? '');
        const refused = /^(0|false|no)$/i.test(String(each.allow_as_destination ?? '1'));
        if (key !== '' && each.id !== undefined && !refused && !ids.has(key)) ids.set(key, each.id);
      }
      if (ids.size === 0) {
        return { ok: false, retry: true, message: 'Leopards gave no cities to deliver to' };
      }
      this.#cities = { at: Date.now(), ids };
    }
    const id = this.#cities.ids.get(cityKey(city));
    return id === undefined
      ? { ok: false, retry: false, message: `Leopards does not deliver to ${city}` }
      : { ok: true, value: id };
  }

  async #call(
    credentials: CourierCredentials,
    method: string,
    body: Record<string, unknown>,
  ): Promise<CourierResult<LeopardsAnswer>> {
    const base = (this.options.baseUrl ?? LEOPARDS_API_URL).replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetch(`${base}/${method}/format/json/`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: credentials.apiKey ?? '',
          api_password: credentials.apiPassword ?? '',
          ...body,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        ok: false,
        retry: true,
        message: `Leopards could not be reached: ${(error as Error).message}`.slice(0, 1_000),
      };
    }
    const json = (await response.json().catch(() => null)) as LeopardsAnswer | null;
    if (response.ok && json !== null && Number(json.status) === 1) return { ok: true, value: json };
    const said = errorText(json?.error);
    return {
      ok: false,
      retry: response.status >= 500 || response.status === 429 || (response.ok && json === null),
      message: `Leopards: ${said || `it answered ${response.status}`}`.slice(0, 1_000),
    };
  }
}

/** A city's name as matched against Leopards': its letters and digits, in lower case. */
function cityKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** What an API said went wrong, as text: a message, or messages by field. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error.trim();
  if (Array.isArray(error)) return error.map(errorText).filter(Boolean).join('; ');
  if (error !== null && typeof error === 'object') {
    return Object.values(error).map(errorText).filter(Boolean).join('; ');
  }
  return '';
}

/**
 * A courier that books nothing (ADR-149): for trying bookings out in development and tests. Its
 * tracking numbers start "HT", and its parcels stay booked until {@link TestCourier.set} moves
 * them, in this process alone.
 */
export class TestCourier implements CourierAdapter {
  readonly info: CourierInfo = {
    courier: 'test',
    name: 'Test courier',
    credentials: [{ key: 'key', label: 'Any key' }],
    pickupCode: null,
    test: true,
  };

  readonly #statuses = new Map<string, string>();
  /** What it was asked to book, the latest last. */
  readonly booked: CourierShipment[] = [];

  /** Says the parcel is at `status`, as a courier would, such as "Out For Delivery". */
  set(trackingNumber: string, status: string): void {
    this.#statuses.set(trackingNumber, status);
  }

  async book(
    _credentials: CourierCredentials,
    shipment: CourierShipment,
  ): Promise<CourierResult<{ trackingNumber: string }>> {
    this.booked.push(shipment);
    const trackingNumber = `HT${String(Date.now()).slice(-7)}${String(this.booked.length).padStart(3, '0')}`;
    this.#statuses.set(trackingNumber, 'Booked');
    return { ok: true, value: { trackingNumber } };
  }

  async track(
    _credentials: CourierCredentials,
    trackingNumbers: readonly string[],
  ): Promise<CourierResult<CourierTracking[]>> {
    return {
      ok: true,
      value: trackingNumbers.flatMap((trackingNumber) => {
        const status = this.#statuses.get(trackingNumber);
        return status ? [{ trackingNumber, status }] : [];
      }),
    };
  }

  async cancel(
    _credentials: CourierCredentials,
    trackingNumber: string,
  ): Promise<CourierResult<null>> {
    if (!this.#statuses.has(trackingNumber)) {
      return { ok: false, retry: false, message: 'Test courier: no such booking' };
    }
    this.#statuses.set(trackingNumber, 'Cancelled');
    return { ok: true, value: null };
  }
}
