// Hatti's AI gateway (09 §2.1, ADR-463): every call to a model goes through it. The model and the
// key come from the host's configuration, never from code, so changing models is a configuration
// change. Answers a machine reads come back through a tool the model must call, and are checked
// before anything uses them; a refusal, a failure and an answer that does not fit are told apart,
// so each feature can fall back to what it does without AI.

/** How the gateway reaches the model provider: Anthropic's Messages API. */
export interface AiGatewayOptions {
  apiKey: string;
  /** The model's ID, as the host's configuration names it. */
  model: string;
  /** The API's address; Anthropic's unless given, as for a proxy. */
  baseUrl?: string;
  /** How long one call may take before it is given up, in milliseconds. */
  timeoutMs?: number;
  /** What makes its requests; the platform's `fetch` unless given. */
  fetch?: typeof fetch;
}

/** What a call cost, in the provider's tokens, for each shop's metering. */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Why a call gave nothing to use. */
export type AiFailure =
  /** The model declined. */
  | 'refused'
  /** The provider could not be reached, or answered with an error. */
  | 'failed'
  /** The model's answer did not fit what was asked for. */
  | 'invalid';

export type AiResult<T> =
  | { ok: true; value: T; usage: AiUsage }
  | { ok: false; reason: AiFailure; detail: string; usage?: AiUsage };

/** A picture the model looks at with the prompt (APP-02): a JPEG, PNG, WebP or GIF's bytes. */
export interface AiImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: Buffer;
}

/** The most pictures one request takes. */
export const AI_IMAGE_LIMITS = { count: 5, bytes: 3_750_000 } as const;

/** A PDF the model reads, such as a bank's receipt for a transfer (PAY-08). */
export interface AiDocument {
  mediaType: 'application/pdf';
  data: Buffer;
}

/** The most PDFs one request takes, and how large each may be. */
export const AI_DOCUMENT_LIMITS = { count: 1, bytes: 10 * 1024 * 1024 } as const;

/** A request whose answer comes back through one tool, checked by `parse`. */
export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  /** Pictures given before the prompt, for the model to look at. */
  images?: readonly AiImage[];
  /** PDFs given before the prompt, for the model to read. */
  documents?: readonly AiDocument[];
  tool: { name: string; description: string; inputSchema: Record<string, unknown> };
  maxTokens: number;
  /** What the tool's input means, or null when it does not fit. */
  parse: (input: unknown) => T | null;
}

const ANTHROPIC_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 60_000;
/** Answers worth trying once more: rate limited, overloaded, or the provider's own error. */
const RETRIED = new Set([429, 500, 502, 503, 504, 529]);

interface MessagesResponse {
  content?: { type: string; name?: string; input?: unknown; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AiGateway {
  readonly #fetch: typeof fetch;
  readonly #url: string;

  constructor(private readonly options: AiGatewayOptions) {
    if (!options.apiKey) throw new Error('The AI gateway needs an API key');
    if (!options.model) throw new Error('The AI gateway needs a model, from configuration');
    this.#fetch = options.fetch ?? fetch;
    this.#url = `${(options.baseUrl ?? ANTHROPIC_URL).replace(/\/+$/, '')}/v1/messages`;
  }

  /** The model calls go to, as configured. */
  get model(): string {
    return this.options.model;
  }

  /**
   * Asks the model, and takes its answer from the one tool it must call: checked by the
   * request's `parse`, or why there is none to use. Tried once more when the provider is busy.
   */
  async structured<T>(request: StructuredRequest<T>): Promise<AiResult<T>> {
    const images = request.images ?? [];
    const documents = request.documents ?? [];
    if (
      images.length > AI_IMAGE_LIMITS.count ||
      images.some((image) => image.data.length > AI_IMAGE_LIMITS.bytes)
    ) {
      return { ok: false, reason: 'invalid', detail: 'Too many pictures, or one too large' };
    }
    if (
      documents.length > AI_DOCUMENT_LIMITS.count ||
      documents.some((document) => document.data.length > AI_DOCUMENT_LIMITS.bytes)
    ) {
      return { ok: false, reason: 'invalid', detail: 'Too many PDFs, or one too large' };
    }
    const content =
      images.length === 0 && documents.length === 0
        ? request.prompt
        : [
            ...documents.map((document) => ({
              type: 'document',
              source: {
                type: 'base64',
                media_type: document.mediaType,
                data: document.data.toString('base64'),
              },
            })),
            ...images.map((image) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mediaType,
                data: image.data.toString('base64'),
              },
            })),
            { type: 'text', text: request.prompt },
          ];
    const body = JSON.stringify({
      model: this.options.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content }],
      tools: [
        {
          name: request.tool.name,
          description: request.tool.description,
          input_schema: request.tool.inputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: request.tool.name },
    });
    let response: Response | null = null;
    let detail = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await delay(500 + Math.random() * 1000);
      try {
        response = await this.#fetch(this.#url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.options.apiKey,
            'anthropic-version': API_VERSION,
          },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        response = null;
        detail = `The AI provider could not be reached: ${(error as Error).message}`;
        continue;
      }
      if (response.ok || !RETRIED.has(response.status)) break;
      detail = `The AI provider answered ${response.status}`;
    }
    if (!response) return { ok: false, reason: 'failed', detail };
    if (!response.ok) {
      return {
        ok: false,
        reason: 'failed',
        detail: `The AI provider answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      };
    }
    const answer = (await response.json()) as MessagesResponse;
    const usage: AiUsage = {
      inputTokens: answer.usage?.input_tokens ?? 0,
      outputTokens: answer.usage?.output_tokens ?? 0,
    };
    if (answer.stop_reason === 'refusal') {
      return { ok: false, reason: 'refused', detail: 'The model declined', usage };
    }
    const call = answer.content?.find(
      (block) => block.type === 'tool_use' && block.name === request.tool.name,
    );
    if (!call) {
      return { ok: false, reason: 'invalid', detail: 'The model gave no answer to use', usage };
    }
    if (answer.stop_reason === 'max_tokens') {
      return { ok: false, reason: 'invalid', detail: 'The answer was cut off', usage };
    }
    const value = request.parse(call.input);
    if (value === null) {
      return { ok: false, reason: 'invalid', detail: "The model's answer did not fit", usage };
    }
    return { ok: true, value, usage };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
