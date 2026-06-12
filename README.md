# voxout

Provider gateway for speech synthesis, sound effects, and ASR.

voxout exposes OpenAI-compatible audio endpoints plus a provider configuration
surface. It stores provider settings in MySQL through Prisma; provider keys,
base URLs, and model choices should be managed from the web console or inserted
into the `ProviderConfig` table.

## Providers

- `edge`: Microsoft Edge online TTS.
- `mimo`: Xiaomi MiMo TTS with preset voices, voice design, and ASR.
- `elevenlabs`: ElevenLabs TTS, ASR, and sound-effects generation.
- `bilibili-asr`: ASR through the `bilibili-mcp` Flask API.

## API

OpenAI-compatible audio API:

- `GET /v1/models`
- `POST /v1/audio/speech`
- `POST /v1/audio/effect`
- `POST /v1/audio/transcriptions`

The OpenAI-style `model` field maps to a voxout provider id such as `edge`,
`mimo`, `elevenlabs`, or `bilibili-asr`.

Provider management API:

- `GET /health`
- `GET /api/providers`
- `PUT /api/providers/:providerId/config`
- `GET /audio/:file`

The old `/v1/tts/*` API has been removed.

## Examples

Speech generation:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/speech \
  -H 'content-type: application/json' \
  --output speech.mp3 \
  --data '{"model":"edge","input":"你好，voxout。","voice":"zh-CN-XiaoyiNeural","response_format":"mp3"}'
```

Sound effect generation:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/effect \
  -H 'content-type: application/json' \
  --output effect.mp3 \
  --data '{"model":"elevenlabs","input":"a short cinematic whoosh","duration_seconds":1.5,"prompt_influence":0.3,"response_format":"mp3_44100_128"}'
```

Transcription from a local file:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/transcriptions \
  -F model=mimo \
  -F response_format=json \
  -F language=auto \
  -F file=@sample.wav
```

Transcription from a URL is supported as a voxout extension for URL-based
providers:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/transcriptions \
  -F model=bilibili-asr \
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
