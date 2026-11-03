import { describe, expect, it, vi } from 'vitest';
import { generateSpeech, transcribe } from 'ai';
import { createLokutor } from '../src';

const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  return vi.fn(async (url: any, init: any) => handler(String(url), init ?? {}));
}

describe('speech', () => {
  it('posts to /tts/synthesize with bearer auth and returns the WAV bytes', async () => {
    const f = mockFetch(() => new Response(wav, { headers: { 'content-type': 'audio/wav' } }));
    const lokutor = createLokutor({ apiKey: 'sk_test', fetch: f as any });
    const { audio, warnings } = await generateSpeech({ model: lokutor.speech('versa-2.0'), text: 'Hola', voice: 'M2', language: 'es' });
    expect(Array.from(audio.uint8Array)).toEqual(Array.from(wav));
    expect(warnings).toEqual([]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.lokutor.com/v1/tts/synthesize');
    expect((init.headers as any).Authorization).toBe('Bearer sk_test');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hola', voice: 'M2', language: 'es' });
  });

  it('defaults voice F1 and language en, warns on unsupported settings', async () => {
    const f = mockFetch(() => new Response(wav));
    const lokutor = createLokutor({ apiKey: 'k', fetch: f as any });
    const r = await lokutor.speech().doGenerate({ text: 'Hi', speed: 1.2, outputFormat: 'mp3', instructions: 'calm' });
    expect(JSON.parse(f.mock.calls[0][1].body as string)).toEqual({ text: 'Hi', voice: 'F1', language: 'en' });
    expect(r.warnings.map((w) => (w as any).feature).sort()).toEqual(['instructions', 'outputFormat', 'speed']);
  });

  it('turns an API error into APICallError with the server message', async () => {
    const f = mockFetch(() => new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'Balance too low' } }), { status: 402 }));
    const lokutor = createLokutor({ apiKey: 'k', fetch: f as any });
    await expect(lokutor.speech().doGenerate({ text: 'x' })).rejects.toMatchObject({ statusCode: 402, isRetryable: false, message: expect.stringContaining('Balance too low') });
  });

  it('marks 429 and 5xx retryable', async () => {
    const f = mockFetch(() => new Response('busy', { status: 503 }));
    const lokutor = createLokutor({ apiKey: 'k', fetch: f as any });
    await expect(lokutor.speech().doGenerate({ text: 'x' })).rejects.toMatchObject({ isRetryable: true });
  });

  it('fails clearly without a key', async () => {
    const old = process.env.LOKUTOR_API_KEY;
    delete process.env.LOKUTOR_API_KEY;
    try {
      await expect(createLokutor({ fetch: vi.fn() as any }).speech().doGenerate({ text: 'x' })).rejects.toThrow(/LOKUTOR_API_KEY/);
    } finally {
      if (old !== undefined) process.env.LOKUTOR_API_KEY = old;
    }
  });
});

describe('transcription', () => {
  const response = {
    language_code: 'spa',
    language_probability: 1.0,
    text: 'Hola a todos.',
    words: [
      { text: 'hola', start: 0.1, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
      { text: ' ', start: 0.4, end: 0.5, type: 'spacing', speaker_id: 'speaker_0' },
      { text: 'a', start: 0.5, end: 0.6, type: 'word', speaker_id: 'speaker_1' },
      { text: 'todos', start: 0.6, end: 1.2, type: 'word', speaker_id: 'speaker_1' },
    ],
  };

  it('uploads multipart to /speech-to-text and maps words to segments', async () => {
    const f = mockFetch(() => new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } }));
    const lokutor = createLokutor({ apiKey: 'sk_test', fetch: f as any });
    const r = await transcribe({
      model: lokutor.transcription('lokutor-stt'),
      audio: wav,
      providerOptions: { lokutor: { languageCode: 'es', diarize: true, numSpeakers: 2 } },
    });
    expect(r.text).toBe('Hola a todos.');
    expect(r.language).toBe('es');
    expect(r.durationInSeconds).toBeCloseTo(1.2);
    expect(r.segments).toEqual([
      { text: 'hola', startSecond: 0.1, endSecond: 0.4 },
      { text: 'a', startSecond: 0.5, endSecond: 0.6 },
      { text: 'todos', startSecond: 0.6, endSecond: 1.2 },
    ]);
    expect((r.providerMetadata as any).lokutor.speakers).toEqual(['speaker_0', 'speaker_1', 'speaker_1']);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.lokutor.com/v1/speech-to-text');
    expect((init.headers as any).Authorization).toBe('Bearer sk_test');
    const form = init.body as FormData;
    expect(form.get('language_code')).toBe('es');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('num_speakers')).toBe('2');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('accepts base64 audio and leaves language undefined when absent', async () => {
    const f = mockFetch(() => new Response(JSON.stringify({ text: 'ok', words: [] })));
    const lokutor = createLokutor({ apiKey: 'k', fetch: f as any });
    const r = await lokutor.transcription().doGenerate({ audio: Buffer.from(wav).toString('base64'), mediaType: 'audio/wav' });
    expect(r.language).toBeUndefined();
    expect(r.segments).toEqual([]);
    const file = (f.mock.calls[0][1].body as FormData).get('file') as Blob;
    expect(file.size).toBe(wav.length);
  });

  it('warns on non-WAV media types', async () => {
    const f = mockFetch(() => new Response(JSON.stringify({ text: '', words: [] })));
    const r = await createLokutor({ apiKey: 'k', fetch: f as any }).transcription().doGenerate({ audio: wav, mediaType: 'audio/mpeg' });
    expect(r.warnings).toHaveLength(1);
  });
});

describe('provider shape', () => {
  it('rejects language/embedding/image models', () => {
    const p = createLokutor({ apiKey: 'k' });
    expect(() => p.languageModel('x')).toThrow();
    expect(() => p.embeddingModel('x')).toThrow();
    expect(() => p.imageModel('x')).toThrow();
    expect(p.specificationVersion).toBe('v4');
  });
});
