import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// What the messaging module's tests share: Meta's Graph API as Hatti asks it of a shop's own
// WhatsApp number (ADR-419) and its templates (ADR-420).

export const TOKEN = 'EAAQbusinessToken'.padEnd(80, 'x');
export const WABA = '102290129340398';
export const NUMBER = '106540352242922';

/** Meta's Graph API, each request kept. */
export class FakeGraph {
  readonly requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  /** The codes Meta takes. */
  codes = new Set(['good-code']);
  registerError: string | null = null;
  /** The account's templates, as Meta keeps them. */
  readonly templates: {
    id: string;
    name: string;
    language: string;
    status: string;
    rejected_reason?: string;
  }[] = [];
  /** What Meta says of the next template sent, if it refuses it. */
  templateError: string | null = null;
  /** What Meta says of a template it refuses by its name and language, "name:ur". */
  readonly templateRefusals = new Map<string, string>();
  readonly #server: Server;

  constructor() {
    this.#server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        const url = new URL(request.url!, 'http://graph');
        const path = url.pathname.replace(/^\/v26\.0\//, '');
        this.requests.push({
          method: request.method!,
          path,
          auth: request.headers.authorization ?? null,
          body: raw ? JSON.parse(raw) : null,
        });
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (path === 'oauth/access_token') {
          const ok =
            url.searchParams.get('client_id') === '1234567890' &&
            url.searchParams.get('client_secret') === 'app-secret' &&
            this.codes.has(url.searchParams.get('code') ?? '');
          return ok
            ? send(200, { access_token: TOKEN, token_type: 'bearer' })
            : send(400, {
                error: { message: 'This authorization code has been used.', code: 100 },
              });
        }
        if (request.headers.authorization !== `Bearer ${TOKEN}`) {
          return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
        }
        if (path === `${WABA}/phone_numbers`) {
          return send(200, {
            data: [
              {
                id: NUMBER,
                display_phone_number: '+92 300 1234567',
                verified_name: 'Zari Fashions',
                quality_rating: 'GREEN',
              },
            ],
          });
        }
        if (path === `${WABA}/subscribed_apps`) return send(200, { success: true });
        if (path === `${NUMBER}/register`) {
          return this.registerError
            ? send(400, { error: { message: this.registerError, code: 133005 } })
            : send(200, { success: true });
        }
        if (path === `${WABA}/message_templates` && request.method === 'POST') {
          if (this.templateError) {
            return send(400, {
              error: {
                message: 'Invalid parameter',
                error_user_msg: this.templateError,
                code: 100,
              },
            });
          }
          const sent = JSON.parse(raw) as { name: string; language: string; category: string };
          const refusal = this.templateRefusals.get(`${sent.name}:${sent.language}`);
          if (refusal) {
            return send(400, { error: { message: refusal, error_user_msg: refusal, code: 100 } });
          }
          const id = String(594425479261596 + this.templates.length);
          this.templates.push({ id, name: sent.name, language: sent.language, status: 'PENDING' });
          return send(200, { id, status: 'PENDING', category: sent.category });
        }
        if (path === `${WABA}/message_templates` && request.method === 'GET') {
          return send(200, { data: this.templates });
        }
        if (path === `${WABA}/message_templates` && request.method === 'DELETE') {
          const at = this.templates.findIndex((each) => each.id === url.searchParams.get('hsm_id'));
          if (at < 0) return send(404, { error: { message: 'Template not found', code: 100 } });
          this.templates.splice(at, 1);
          return send(200, { success: true });
        }
        send(404, { error: { message: 'Unknown path', code: 803 } });
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
