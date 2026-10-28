import { describe, expect, it } from 'vitest';
import { SPEECH_LIMITS, SpeechToText } from './speech.js';

/** A fake speech server answering `body` with `status`, each request's form kept. */
function server(status: number, body: unknown) {
  const forms: { url: string; form: FormData; headers: RequestInit['headers'] }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    forms.push({ url, form: init.body as FormData, headers: init.headers });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, forms };
}

const OGG = Buffer.from('OggS voice note');

describe("A voice note's words, from Hatti's own speech-to-text server (MSG-11, ADR-871)", () => {
  it('sends the audio as a form, in the language spoken, and keeps the words it heard', async () => {
    const { fetch, forms } = server(200, { text: '  do   lawn suit  medium\n bhej dein ' });
    const speech = new SpeechToText({ url: 'http://whisper:8080/inference', apiKey: 'k', fetch });
    expect(await speech.transcribe(OGG, 'audio/ogg; codecs=opus', 'ur')).toEqual({
      ok: true,
      text: 'do lawn suit medium bhej dein',
    });
    const [{ url, form, headers }] = forms as [(typeof forms)[number]];
    expect(url).toBe('http://whisper:8080/inference');
    expect(headers).toEqual({ authorization: 'Bearer k' });
    expect(form.get('language')).toBe('ur');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect([file.name, file.size]).toEqual(['voice-note.ogg', OGG.length]);
  });

  it('says what failed: a server down or wrong, an answer without words, audio too long', async () => {
    const failing = new SpeechToText({ url: 'http://whisper', ...server(500, 'busy') });
    expect(await failing.transcribe(OGG, 'audio/ogg', 'ur')).toEqual({
      ok: false,
      reason: 'failed',
      detail: '500: busy',
    });
    const wordless = new SpeechToText({ url: 'http://whisper', ...server(200, { words: [] }) });
    expect((await wordless.transcribe(OGG, 'audio/ogg', 'ur')).ok).toBe(false);
    const { fetch, forms } = server(200, { text: 'never asked' });
    const long = new SpeechToText({ url: 'http://whisper', fetch });
    const audio = Buffer.alloc(SPEECH_LIMITS.bytes + 1);
    expect(await long.transcribe(audio, 'audio/ogg', 'ur')).toMatchObject({ reason: 'too_long' });
    expect(forms).toEqual([]);
  });
});
