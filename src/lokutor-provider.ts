import {
  APICallError,
  NoSuchModelError,
  type ProviderV4,
  type SharedV4Warning,
  type SpeechModelV4,
  type TranscriptionModelV4,
} from '@ai-sdk/provider';

export const VERSION = '0.1.0';

export interface LokutorProviderSettings {
  /** API key. Defaults to the LOKUTOR_API_KEY environment variable. */
  apiKey?: string;
  /** Base URL of the API, without a trailing slash. Defaults to https://api.lokutor.com/v1. */
  baseURL?: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for tests or proxies. */
  fetch?: typeof fetch;
}

export interface LokutorProvider extends ProviderV4 {
  (modelId?: string): SpeechModelV4;
  /** Text-to-speech model. The id is the model id (`versa-2.0`); the voice is chosen per call. */
  speech(modelId?: string): SpeechModelV4;
  /** Speech-to-text model. */
  transcription(modelId?: string): TranscriptionModelV4;
}

/** Provider options accepted under the `lokutor` key of `providerOptions`. */
export interface LokutorSpeechOptions {
  /** Voice slot (`F1`-`F5`, `M1`-`M5`) or a `clone_...` id. Overridden by the call's `voice`. */
  voice?: string;
}

export interface LokutorTranscriptionOptions {
  /** ISO-639-1 or ISO-639-3 code: ca de en es eu fr gl it pt. Detected when omitted. */
  languageCode?: string;
  /** Label each word with its speaker (words[].speakerId in providerMetadata). */
  diarize?: boolean;
  /** Number of speakers, 1-32, when known. */
  numSpeakers?: number;
}

const LANGUAGE_3_TO_1: Record<string, string> = {
  cat: 'ca', deu: 'de', eng: 'en', spa: 'es', eus: 'eu', fra: 'fr', glg: 'gl', ita: 'it', por: 'pt',
};

function opt<T = unknown>(providerOptions: Record<string, Record<string, unknown>> | undefined, key: string): T | undefined {
  return providerOptions?.lokutor?.[key] as T | undefined;
}

export function createLokutor(settings: LokutorProviderSettings = {}): LokutorProvider {
  const baseURL = (settings.baseURL ?? 'https://api.lokutor.com/v1').replace(/\/+$/, '');
  const doFetch = settings.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const authHeaders = (): Record<string, string> => {
    const apiKey = settings.apiKey ?? (typeof process !== 'undefined' ? process.env?.LOKUTOR_API_KEY : undefined);
    if (!apiKey) {
      throw new Error('Lokutor API key is missing. Pass `apiKey` to createLokutor() or set the LOKUTOR_API_KEY environment variable.');
    }
    return { Authorization: `Bearer ${apiKey}`, 'User-Agent': `ai-sdk-provider-lokutor/${VERSION}`, ...settings.headers };
  };

  async function request(url: string, init: RequestInit, extra: Record<string, string | undefined> | undefined, requestBody: unknown) {
    const headers: Record<string, string> = { ...authHeaders() };
    for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined) headers[k] = v;
    Object.assign(headers, init.headers);
    const res = await doFetch(url, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text || res.statusText;
      try {
        const j = JSON.parse(text);
        message = j?.detail?.message ?? j?.message ?? j?.error?.message ?? (typeof j?.error === 'string' ? j.error : message);
      } catch { /* not JSON */ }
      throw new APICallError({
        message: `Lokutor API error (${res.status}): ${message}`,
        url,
        requestBodyValues: requestBody,
        statusCode: res.status,
        responseBody: text,
        isRetryable: res.status === 408 || res.status === 429 || res.status >= 500,
      });
    }
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });
    return { res, responseHeaders };
  }

  const speech = (modelId = 'versa-2.0'): SpeechModelV4 => ({
    specificationVersion: 'v4',
    provider: 'lokutor.speech',
    modelId,
    async doGenerate(options) {
      const warnings: SharedV4Warning[] = [];
      if (options.outputFormat && options.outputFormat.toLowerCase() !== 'wav') {
        warnings.push({ type: 'unsupported', feature: 'outputFormat', details: `Lokutor returns WAV (16-bit PCM, 44.1 kHz, mono); "${options.outputFormat}" was ignored.` });
      }
      if (options.instructions) warnings.push({ type: 'unsupported', feature: 'instructions' });
      if (options.speed != null) {
        warnings.push({ type: 'unsupported', feature: 'speed', details: 'Accepted by the API but has no effect on versa-2.0, so it is not sent.' });
      }
      const voice = options.voice ?? opt<string>(options.providerOptions, 'voice') ?? 'F1';
      const body = {
        text: options.text,
        voice,
        language: options.language && options.language !== 'auto' ? options.language : 'en',
      };
      const bodyText = JSON.stringify(body);
      const timestamp = new Date();
      const { res, responseHeaders } = await request(
        `${baseURL}/tts/synthesize`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyText, signal: options.abortSignal },
        options.headers,
        body,
      );
      const audio = new Uint8Array(await res.arrayBuffer());
      return {
        audio,
        warnings,
        request: { body: bodyText },
        response: { timestamp, modelId, headers: responseHeaders },
      };
    },
  });

  const transcription = (modelId = 'lokutor-stt'): TranscriptionModelV4 => ({
    specificationVersion: 'v4',
    provider: 'lokutor.transcription',
    modelId,
    async doGenerate(options) {
      const warnings: SharedV4Warning[] = [];
      if (options.mediaType && !/wav/i.test(options.mediaType)) {
        warnings.push({ type: 'compatibility', feature: 'mediaType', details: `Lokutor decodes WAV only; "${options.mediaType}" will probably be refused. Convert to WAV first.` });
      }
      const bytes = typeof options.audio === 'string' ? Uint8Array.from(atob(options.audio), (c) => c.charCodeAt(0)) : options.audio;
      const form = new FormData();
      form.append('file', new Blob([bytes as BlobPart], { type: 'audio/wav' }), 'audio.wav');
      const fields: Record<string, string> = { timestamps_granularity: 'word' };
      const languageCode = opt<string>(options.providerOptions, 'languageCode');
      const diarize = opt<boolean>(options.providerOptions, 'diarize');
      const numSpeakers = opt<number>(options.providerOptions, 'numSpeakers');
      if (languageCode) fields.language_code = languageCode;
      if (diarize != null) fields.diarize = String(diarize);
      if (numSpeakers != null) fields.num_speakers = String(numSpeakers);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);

      const timestamp = new Date();
      const { res, responseHeaders } = await request(
        `${baseURL}/speech-to-text`,
        { method: 'POST', body: form, signal: options.abortSignal },
        options.headers,
        fields,
      );
      const json = (await res.json()) as {
        text?: string;
        language_code?: string;
        words?: Array<{ text: string; start: number; end: number; type?: string; speaker_id?: string }>;
      };
      const words = (json.words ?? []).filter((w) => w.type !== 'spacing');
      const lang = json.language_code;
      const result = {
        text: json.text ?? '',
        segments: words.map((w) => ({ text: w.text, startSecond: w.start, endSecond: w.end })),
        language: lang ? (LANGUAGE_3_TO_1[lang] ?? lang) : undefined,
        durationInSeconds: json.words?.length ? Math.max(...json.words.map((w) => w.end)) : undefined,
        warnings,
        request: { body: JSON.stringify(fields) },
        response: { timestamp, modelId, headers: responseHeaders, body: json },
        ...(diarize ? { providerMetadata: { lokutor: { speakers: words.map((w) => w.speaker_id ?? 'speaker_0') } } } : {}),
      };
      return result;
    },
  });

  const provider = Object.assign((modelId?: string) => speech(modelId), {
    specificationVersion: 'v4' as const,
    speech,
    speechModel: speech,
    transcription,
    transcriptionModel: transcription,
    languageModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: 'languageModel' });
    },
    embeddingModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
    },
    imageModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
    },
  });
  return provider as unknown as LokutorProvider;
}

/** Default instance; reads LOKUTOR_API_KEY. */
export const lokutor = createLokutor();
