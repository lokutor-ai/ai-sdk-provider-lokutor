# Lokutor provider for the Vercel AI SDK

[Lokutor](https://lokutor.com) text-to-speech and speech-to-text for the [AI SDK](https://ai-sdk.dev), on Lokutor's own speech models. Nine languages: English, Spanish, Catalan, Galician, Basque, Portuguese, French, Italian and German.

This provider implements the AI SDK 7 provider specification (`v4`): `generateSpeech` and `transcribe`. It has no language model. Lokutor's agent platform is a separate product, see the [docs](https://docs.lokutor.com).

## Install

```bash
npm install @lokutor/ai-sdk-provider ai
```

Get an API key at [app.lokutor.com](https://app.lokutor.com) and set it:

```bash
export LOKUTOR_API_KEY=sk_your_key_here
```

## Text to speech

```ts
import { experimental_generateSpeech as generateSpeech } from 'ai'; // `generateSpeech` in recent versions
import { lokutor } from '@lokutor/ai-sdk-provider';
import { writeFile } from 'node:fs/promises';

const { audio } = await generateSpeech({
  model: lokutor.speech('versa-2.0'),
  text: 'Hello from Lokutor.',
  voice: 'F1',        // F1-F5 female, M1-M5 male, or a clone_... id
  language: 'en',     // en es ca gl eu pt fr it de
});

await writeFile('hello.wav', audio.uint8Array); // WAV, 16-bit PCM, 44.1 kHz, mono
```

Notes:

- The voice is a slot (`F1`-`F5`, `M1`-`M5`) and the speaker depends on `language`: see [Voices, languages and models](https://docs.lokutor.com/voices-languages-models). Default `F1`, language `en`.
- Output is always WAV. `outputFormat` other than `wav`, `speed` (no effect on versa-2.0) and `instructions` produce a warning and are not sent.
- Text is limited to 5,000 characters per request.

## Speech to text

```ts
import { transcribe } from 'ai';
import { lokutor } from '@lokutor/ai-sdk-provider';
import { readFile } from 'node:fs/promises';

const result = await transcribe({
  model: lokutor.transcription('lokutor-stt'),
  audio: await readFile('meeting.wav'),
  providerOptions: {
    lokutor: { languageCode: 'es', diarize: true, numSpeakers: 3 },
  },
});

console.log(result.text);
console.log(result.segments);                    // one segment per word, with start/end seconds
console.log(result.providerMetadata?.lokutor);   // { speakers: ['speaker_0', ...] } when diarize is true
```

Provider options (`providerOptions.lokutor`):

| Option | Description |
| - | - |
| `languageCode` | `ca de en es eu fr gl it pt` (ISO-639-1 or -3). Detected when omitted. |
| `diarize` | Label who said each word. Runs on a CPU service, so it is not real time: see the [speech-to-text reference](https://docs.lokutor.com/api-reference/speech-to-text). |
| `numSpeakers` | Number of speakers, 1-32, if known. |

The input must be a **WAV** file (8 or 16 bit PCM, 8-48 kHz, up to 10 MB without diarization). Other formats are refused by the API; convert first.

## Settings

```ts
import { createLokutor } from '@lokutor/ai-sdk-provider';

const lokutor = createLokutor({
  apiKey: process.env.LOKUTOR_API_KEY, // default
  baseURL: 'https://api.lokutor.com/v1', // default
  headers: {},
  fetch, // custom fetch
});
```

Errors are thrown as `APICallError` with the server's message and `isRetryable` set for 408, 429 and 5xx (the AI SDK retries those).

## Development

```bash
npm install
npm test        # offline, mocked fetch
npm run build
```

## License

MIT
