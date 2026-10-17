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

/**
 * What asking Meta's Graph API with a shop's own token takes: where it is. Exchanging a code
 * takes Hatti's app too.
 */
export type WhatsAppGraphSettings = Pick<
  WhatsAppSignupSettings,
  'baseUrl' | 'version' | 'timeoutMs'
> &
  Partial<Pick<WhatsAppSignupSettings, 'appId' | 'appSecret'>>;

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

/** A shop's template as Meta is asked to approve it (ADR-420). */
export interface TemplateSubmission {
  name: string;
  language: 'en' | 'ur';
  header: string | null;
  /** {{1}}, if anywhere, is the customer's first name. */
  body: string;
  footer: string | null;
  button: { text: string; url: string } | null;
}

/**
 * A template as Meta's API takes it, its components already laid out: Hatti's library's, in the
 * utility category (ADR-537), or a shop's own, in marketing.
 */
export interface PreparedTemplate {
  name: string;
  language: 'en' | 'ur';
  category: 'MARKETING' | 'UTILITY';
  components: object[];
}

/** An example of {{1}} that Meta asks for with a body that has it. */
const EXAMPLE_NAME = 'Ayesha';

/** The template's components, as Meta's API takes them. */
export function templateComponents(template: TemplateSubmission): object[] {
  return [
    ...(template.header ? [{ type: 'HEADER', format: 'TEXT', text: template.header }] : []),
    {
      type: 'BODY',
      text: template.body,
      ...(template.body.includes('{{1}}') ? { example: { body_text: [[EXAMPLE_NAME]] } } : {}),
    },
    ...(template.footer ? [{ type: 'FOOTER', text: template.footer }] : []),
    ...(template.button
      ? [
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: template.button.text, url: template.button.url }],
          },
        ]
      : []),
  ];
}

/** A template of an account, as Meta says it stands. */
export interface MetaTemplate {
  id: string;
  name: string;
  /** "en", "ur". */
  language: string;
  status: string;
  rejectedReason: string | null;
}

/** What Meta said of a request: what was asked for, or why not. */
export type GraphResult<T> =
  | { ok: true; value: T }
  /** notFound: Meta has no such thing, as one deleted there already. */
  | { ok: false; error: string; notFound?: boolean };

/** Asks Meta's Graph API for what connecting a shop's own number takes. */
export class WhatsAppBusinessClient {
  constructor(private readonly settings: WhatsAppGraphSettings) {}

  /** The business token for the code Embedded Signup gave the admin. */
  async exchangeCode(code: string): Promise<GraphResult<string>> {
    const { appId, appSecret } = this.settings;
    if (!appId || !appSecret) return { ok: false, error: "Hatti's Meta app isn't set up here" };
    const query = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
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

  /**
   * Sends a shop's own template to Meta for approval on the account, in the marketing category:
   * Meta's ID for it and how it stands, as a status Meta names ("PENDING").
   */
  async createTemplate(
    token: string,
    businessAccountId: string,
    template: TemplateSubmission,
  ): Promise<GraphResult<{ id: string; status: string }>> {
    return this.submitTemplate(token, businessAccountId, {
      name: template.name,
      language: template.language,
      category: 'MARKETING',
      components: templateComponents(template),
    });
  }

  /** Sends a template laid out already to Meta for approval on the account, as createTemplate. */
  async submitTemplate(
    token: string,
    businessAccountId: string,
    template: PreparedTemplate,
  ): Promise<GraphResult<{ id: string; status: string }>> {
    const result = await this.#request<{ id?: unknown; status?: unknown }>(
      'POST',
      `${businessAccountId}/message_templates`,
      {
        name: template.name,
        language: template.language,
        category: template.category,
        components: template.components,
      },
      token,
    );
    if (!result.ok) return result;
    const { id, status } = result.value;
    return typeof id === 'string' && /^[0-9]{1,30}$/.test(id)
      ? { ok: true, value: { id, status: typeof status === 'string' ? status : 'PENDING' } }
      : { ok: false, error: 'Meta gave no ID for the template' };
  }

  /** Deletes a template from the account, by its name and Meta's ID for it. */
  async deleteTemplate(
    token: string,
    businessAccountId: string,
    name: string,
    id: string,
  ): Promise<GraphResult<true>> {
    const query = new URLSearchParams({ name, hsm_id: id });
    return this.#done(
      this.#request('DELETE', `${businessAccountId}/message_templates?${query}`, null, token),
    );
  }

  /** How the account's templates stand, a hundred at most, as Meta says. */
  async templatesOf(
    token: string,
    businessAccountId: string,
  ): Promise<GraphResult<MetaTemplate[]>> {
    const fields = 'id,name,language,status,rejected_reason';
    const result = await this.#request<{ data?: unknown }>(
      'GET',
      `${businessAccountId}/message_templates?fields=${fields}&limit=100`,
      null,
      token,
    );
    if (!result.ok) return result;
    const templates: MetaTemplate[] = [];
    for (const each of Array.isArray(result.value.data) ? result.value.data : []) {
      const row = each as Record<string, unknown>;
      if (typeof row.id !== 'string' || typeof row.status !== 'string') continue;
      const reason = row.rejected_reason;
      templates.push({
        id: row.id,
        name: typeof row.name === 'string' ? row.name : '',
        language: typeof row.language === 'string' ? row.language : '',
        status: row.status,
        rejectedReason: typeof reason === 'string' && reason !== 'NONE' ? reason : null,
      });
    }
    return { ok: true, value: templates };
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
      notFound: response.status === 404,
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
