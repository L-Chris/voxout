# voxout

Provider gateway for speech synthesis, sound effects, and ASR.

voxout exposes OpenAI-compatible audio endpoints plus a provider configuration
surface. It stores provider settings in MySQL through Prisma; provider keys,
base URLs, and model choices should be managed from the web console or inserted
into the `ProviderConfig` table.

## Providers

- `default`: Microsoft Edge online TTS plus direct Bilibili/Bcut URL ASR.
- `openai`: OpenAI TTS, ASR, and custom voice cloning.
- `cartesia`: Cartesia TTS, streaming TTS, ASR, voice listing, and voice cloning.
- `mimo`: Xiaomi MiMo TTS with preset voices, voice design, and ASR.
- `gradium`: Gradium TTS, streaming TTS, ASR, voice listing, and voice cloning.
- `elevenlabs`: ElevenLabs TTS, ASR, sound effects, isolation, voice design, and voice cloning.

## API

OpenAI-compatible audio API:

- `GET /v1/models`
- `POST /v1/audio/speech`
- `POST /v1/audio/voices`
- `POST /v1/audio/transcriptions`

voxout extension audio API:

- `POST /v1/audio/effect`
- `POST /v1/audio/isolation`
- `POST /v1/audio/design`

`/v1/audio/speech` follows the OpenAI speech request shape: `model` is the TTS
model, `input` is the text, `voice` is the voice name or id, and
`response_format`, `speed`, `stream_format`, and `instructions` are optional.
Use voxout's `provider` extension to choose a backend such as `default`,
`openai`, `cartesia`, `mimo`, `gradium`, or `elevenlabs`. The legacy
provider-as-`model` form is still accepted for compatibility.
`/v1/audio/transcriptions` follows the OpenAI multipart shape: `model` is the
ASR model, `file` is the uploaded audio, and `response_format`, `language`, and
`prompt` are optional. Use the `provider` extension to choose a non-OpenAI ASR
backend. `/v1/audio/voices` follows the OpenAI form-data shape with `name`,
`consent`, and `audio_sample`, plus the same optional `provider` extension.
For streaming TTS, pass OpenAI-compatible `stream_format` with `audio` or
`sse`. Streaming support is currently exposed by `default`, `openai`,
`cartesia`, `mimo`, `gradium`, and `elevenlabs`; `elevenlabs` and `gradium`
support raw audio streaming only.

Stored voices are provider-neutral records. Platform-specific voice ids and
account bindings are kept in `VoiceProviderLink`, so one voxout `voice_id` can
be linked to multiple provider accounts. MiMo uploads do not return a platform
voice id; voxout stores the uploaded audio sample in the provider link and uses
that sample with MiMo's voice clone model during TTS.

Provider management API:

- `GET /health`
- `GET /api/providers`
- `GET /api/providers/:providerId/voices`
- `GET /api/voices?provider=:providerId`
- `PUT /api/providers/:providerId/config`
- `GET /audio/:file`

The old `/v1/tts/*` API has been removed.

## Examples

Speech generation:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/speech \
  -H 'content-type: application/json' \
  --output speech.mp3 \
  --data '{"provider":"default","input":"你好，voxout。","voice":"zh-CN-XiaoyiNeural","response_format":"mp3"}'
```

Streaming speech:

```bash
curl -N -X POST http://127.0.0.1:4177/v1/audio/speech \
  -H 'content-type: application/json' \
  --output speech.pcm \
  --data '{"provider":"mimo","model":"mimo-v2.5-tts","input":"你好，voxout。","voice":"Chloe","response_format":"pcm","stream_format":"audio"}'
```

Sound effect generation:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/effect \
  -H 'content-type: application/json' \
  --output effect.mp3 \
  --data '{"provider":"elevenlabs","input":"a short cinematic whoosh","duration_seconds":1.5,"prompt_influence":0.3,"response_format":"mp3_44100_128"}'
```

Voice isolation:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/isolation \
  --output isolated.mp3 \
  -F provider=elevenlabs \
  -F audio=@sample.wav
```

Voice design:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/design \
  -H 'content-type: application/json' \
  --data '{"provider":"elevenlabs","input":"A calm narrator voice with a clean tone.","name":"Calm Narrator","auto_generate_text":true}'
```

Voice cloning from an audio sample:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/voices \
  -F provider=openai \
  -F name='Narrator Clone' \
  -F consent=cons_1234 \
  -F audio_sample=@sample.wav
```

Transcription from a local file:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/transcriptions \
  -F provider=openai \
  -F model=gpt-4o-transcribe \
  -F response_format=json \
  -F language=auto \
  -F file=@sample.wav
```

Transcription from a URL is supported as a voxout extension for URL-based
providers:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/transcriptions \
  -F provider=default \
  -F response_format=text \
  -F url=https://example.com/audio.m4a
```

## Provider Config

```bash
curl -X PUT http://127.0.0.1:4177/api/providers/mimo/config \
  -H 'content-type: application/json' \
  --data '{"enabled":true,"config":{"baseUrl":"https://api.xiaomimimo.com/v1"},"secrets":{"apiKey":"..."} }'
```

The web console at `/` provides the same configuration and invocation workflow.

## Development

```bash
npm install
npm run build
npm test
npm start
```

The web console is built with React, Tailwind CSS, and Vite. Source files live
under `frontend/`; `npm run build:web` writes the static build output to
`public/`. During local UI work, run:

```bash
npm run dev
```

Set `DATABASE_URL` to enable persisted provider settings. Deployment
environment variables are limited to service-level settings such as port,
database URL, audio storage, and global synthesis timeout.

## Static Frontend Deployment

Run `npm run build:web` first. The generated files under `public/` can be served
by voxout itself or copied to the existing static-server document tree:

```bash
rsync -a --delete public/ /home/data/www/tts.rethinkos.com/
```

For the current `nginx-proxy-manager` + `static-server` deployment, route
`tts.rethinkos.com` like this:

- `/`, `/assets/*`, and `/voxout.config.json` -> `static-server:80`
- `/api`, `/audio`, and `/health` -> `voxout:4177`

When the API is exposed on the same origin, keep
`frontend/public/voxout.config.json` as:

```json
{
  "apiBaseUrl": ""
}
```

If the static frontend is hosted on a different origin, set `apiBaseUrl` to the
public voxout API origin, for example `https://tts.rethinkos.com`.
