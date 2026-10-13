// What Hatti asks Meta's Graph API as a Tech Provider (ADR-012, ADR-419): the business token a
// shop's Embedded Signup code is exchanged for, the numbers of the WhatsApp Business Account it
// shared, Hatti's app subscribed to that account's webhooks, and the number registered with
// WhatsApp's Cloud API to send from.

/** Hatti's Meta app and the Embedded Signup configuration shops connect through. */
export interface WhatsAppSignupSettings {
  /** The Meta app's ID, which the admin's Facebook SDK starts Embedded Signup with. */
  appId: string;
  /** The app's secret, which a code is exchanged with: never shown. */
  appSecret: string;
  /** The Facebook Login for Business configuration of Embedded Signup. */
  configurationId: string;
  /** Meta's Graph API: https://graph.facebook.com, unless a test says otherwise. */
  baseUrl: string;
  /** "v26.0". */
  version: string;
  /** How long a request may take; ten seconds unless given. */
  timeoutMs?: number;
}

/** A number of a WhatsApp Business Account, as Meta shows it. */
export interface WhatsAppNumber {
  id: string;
  /** "+92 300 1234567". */
  displayPhoneNumber: string;
  /** The business name Meta approved for the number. */
  verifiedName: string;
  qualityRating: WhatsAppQuality;
}

export const WHATSAPP_QUALITIES = ['green', 'yellow', 'red', 'unknown'] as const;
export type WhatsAppQuality = (typeof WHATSAPP_QUALITIES)[number];

/** What Meta said of a request: what was asked for, or why not. */
export type GraphResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Asks Meta's Graph API for what connecting a shop's own number takes. */
export class WhatsAppBusinessClient {
  constructor(private readonly settings: WhatsAppSignupSettings) {}

  /** The business token for the code Embedded Signup gave the admin. */
  async exchangeCode(code: string): Promise<GraphResult<string>> {
    const query = new URLSearchParams({
      client_id: this.settings.appId,
      client_secret: this.settings.appSecret,
      code,
    });
    const result = await this.#request<{ access_token?: unknown }>(
      'GET',
      `oauth/access_token?${query}`,
      null,
    );
    if (!result.ok) return result;
    const token = result.value.access_token;
    return typeof token === 'string' && token.length > 0
      ? { ok: true, value: token }
      : { ok: false, error: 'Meta gave no access token for the code' };
  }

  /** The numbers of the business account, each as Meta shows it. */
  async numbersOf(
    token: string,
    businessAccountId: string,
  ): Promise<GraphResult<WhatsAppNumber[]>> {
    const fields = 'id,display_phone_number,verified_name,quality_rating';
    const result = await this.#request<{ data?: unknown }>(
      'GET',
      `${businessAccountId}/phone_numbers?fields=${fields}`,
      null,
      token,
    );
    if (!result.ok) return result;
    const numbers: WhatsAppNumber[] = [];
    for (const each of Array.isArray(result.value.data) ? result.value.data : []) {
      const row = each as Record<string, unknown>;
      if (typeof row.id !== 'string') continue;
      numbers.push({
        id: row.id,
        displayPhoneNumber: String(row.display_phone_number ?? '').slice(0, 30),
        verifiedName: String(row.verified_name ?? '').slice(0, 200),
        qualityRating: qualityOf(row.quality_rating),
      });
    }
    return { ok: true, value: numbers };
  }

  /** Subscribes Hatti's app to the account's webhooks: its messages' statuses and replies. */
  async subscribe(token: string, businessAccountId: string): Promise<GraphResult<true>> {
    return this.#done(this.#request('POST', `${businessAccountId}/subscribed_apps`, {}, token));
  }

  /** Stops the account's webhooks to Hatti's app, as the shop disconnects it. */
  async unsubscribe(token: string, businessAccountId: string): Promise<GraphResult<true>> {
    return this.#done(this.#request('DELETE', `${businessAccountId}/subscribed_apps`, null, token));
  }

  /** Registers the number with WhatsApp's Cloud API, setting its two-step verification PIN. */
  async register(token: string, phoneNumberId: string, pin: string): Promise<GraphResult<true>> {
    return this.#done(
      this.#request(
        'POST',
        `${phoneNumberId}/register`,
        { messaging_product: 'whatsapp', pin },
        token,
      ),
    );
  }

  async #done(request: Promise<GraphResult<unknown>>): Promise<GraphResult<true>> {
    const result = await request;
    return result.ok ? { ok: true, value: true } : result;
  }

  /** One request, its token in the Authorization header so that no log of addresses keeps it. */
  async #request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: object | null,
    token?: string,
  ): Promise<GraphResult<T>> {
    const { baseUrl, version, timeoutMs } = this.settings;
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/${version}/${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs ?? 10_000),
      });
    } catch (error) {
      return { ok: false, error: `Meta could not be reached: ${errorText(error)}` };
    }
    const json = (await response.json().catch(() => null)) as
      (T & { error?: { message?: string; error_user_msg?: string; code?: number } }) | null;
    if (response.ok && json && !json.error) return { ok: true, value: json };
    const error = json?.error;
    const said = error?.error_user_msg ?? error?.message ?? `HTTP ${response.status}`;
    return {
      ok: false,
      error: `Meta ${error?.code ?? response.status}: ${said}`.slice(0, 500),
    };
  }
}

/** Meta's quality rating, "GREEN", in Hatti's words; "unknown" for anything else, as "NA". */
export function qualityOf(value: unknown): WhatsAppQuality {
  const quality = typeof value === 'string' ? value.toLowerCase() : '';
  return (WHATSAPP_QUALITIES as readonly string[]).includes(quality)
    ? (quality as WhatsAppQuality)
    : 'unknown';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
