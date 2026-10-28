// Speech to text (MSG-11, ADR-871): a voice note's words, from a speech-to-text server Hatti
// runs itself, whisper.cpp's (MIT licensed) or any that answers as OpenAI's transcriptions do.
// Each takes the audio as a multipart form's `file`, with the language spoken, and answers its
// words as `{ "text": "…" }`. WhatsApp's voice notes are Ogg Opus, which whisper.cpp's server
// reads when started with --convert.

export interface SpeechToTextOptions {
  /**
   * Where the audio goes: whisper.cpp's server at `/inference`, or an OpenAI-compatible
   * server's `/v1/audio/transcriptions`.
   */
  url: string;
  /** Sent as a bearer token, where the server asks for one. */
  apiKey?: string;
  /** The model's name, for a server that serves more than one. */
  model?: string;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof globalThis.fetch;
}

export const SPEECH_LIMITS = {
  /** The most audio sent at once: a few minutes of a voice note. */
  bytes: 2 * 1024 * 1024,
  /** The most words kept of what was heard. */
  characters: 4_000,
} as const;

export type SpeechResult =
  { ok: true; text: string } | { ok: false; reason: 'failed' | 'too_long'; detail: string };

/** A voice note's words, from the speech-to-text server configured. */
export class SpeechToText {
  readonly #fetch: typeof globalThis.fetch;

  constructor(private readonly options: SpeechToTextOptions) {
    if (!options.url) throw new Error('Speech to text needs its server’s address');
    this.#fetch = options.fetch ?? fetch;
  }

  /** What `audio`, in `mediaType`, says, heard as `language` (ISO 639-1: "ur"). */
  async transcribe(audio: Buffer, mediaType: string, language: string): Promise<SpeechResult> {
    if (audio.length > SPEECH_LIMITS.bytes) {
      return { ok: false, reason: 'too_long', detail: `${audio.length} bytes of audio` };
    }
    const form = new FormData();
    const extension = mediaType.includes('ogg') ? 'ogg' : (mediaType.split('/')[1] ?? 'audio');
    form.append('file', new Blob([audio], { type: mediaType }), `voice-note.${extension}`);
    form.append('language', language);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (this.options.model) form.append('model', this.options.model);
    let response: Response;
    try {
      response = await this.#fetch(this.options.url, {
        method: 'POST',
        headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      return { ok: false, reason: 'failed', detail: `Not reached: ${String(error)}`.slice(0, 300) };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, reason: 'failed', detail: `${response.status}: ${body}`.slice(0, 300) };
    }
    const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== 'string') {
      return { ok: false, reason: 'failed', detail: 'It answered without the words' };
    }
    return {
      ok: true,
      text: body.text.replace(/\s+/g, ' ').trim().slice(0, SPEECH_LIMITS.characters),
    };
  }
}
