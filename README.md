# voxout

> **Developed with [Qwen3.7-Max](https://qwenlm.github.io/)** — This project was built by the AI model Qwen3.7-Max.

OpenAI-compatible audio gateway for speech, transcription, sound effects, audio
isolation, voice design, and voice cloning.

voxout gives one stable API and one web console for multiple audio providers.
Applications can call OpenAI-style endpoints while operators switch providers,
manage keys, route models, test voices, and persist provider-specific settings
without changing client code.

## Why voxout

- **OpenAI-compatible surface**: use familiar `/v1/audio/*` endpoints for speech,
  transcription, and voice cloning, with Voxout extensions for audio effects,
  isolation, and voice design.
- **Multi-provider routing**: route by explicit `provider` or by model id, so one
  client can use OpenAI, ElevenLabs, Cartesia, Camb.ai, MiMo, Gradium, StepFun,
  and the built-in default provider.
- **More than TTS**: speech synthesis, streaming speech, ASR, text-to-sound,
  vocal/background separation, generated voice previews, and custom voice
  cloning share the same gateway.
- **Provider-neutral voices**: store one Voxout voice record and link it to
  provider-specific voice ids or accounts.
- **Operational console**: configure providers, API keys, models, voices, and
  test requests from the built-in React UI.
- **Self-hostable**: run as a Node service, a Docker image, or split the static
  frontend behind any reverse proxy.

## Supported Providers

| Provider | Capabilities |
|---|---|
| `default` | Microsoft Edge online TTS and Bilibili/Bcut file-upload ASR |
| `openai` | TTS, ASR, custom voice cloning |
| `elevenlabs` | TTS, streaming TTS, ASR, sound effects, isolation, voice design, voice cloning |
| `cartesia` | TTS, streaming TTS, ASR, voice listing, voice cloning |
| `cambai` | TTS, streaming TTS, ASR, text-to-sound, audio separation, voice design, voice cloning |
| `mimo` | Xiaomi MiMo TTS, preset voices, voice design, ASR |
| `gradium` | TTS, streaming TTS, ASR, voice listing, voice cloning |
| `stepfun` | TTS, streaming TTS, ASR streaming, system/cloned voices, voice cloning |

Provider availability depends on your configured API keys and the upstream
account plan. The built-in `default` provider is useful for getting started, but
production deployments should configure the providers that match your quality,
latency, language, and cost requirements.

## API Overview

OpenAI-compatible endpoints:

- `GET /v1/models`
- `POST /v1/audio/speech`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/voices`

Voxout extension endpoints:

- `POST /v1/audio/effect`
- `POST /v1/audio/isolation`
- `POST /v1/audio/voices/design`
- `POST /v1/audio/voices/create`

Management endpoints:

- `GET /health`
- `GET /api/providers`
- `GET /api/providers/:provider_id/voices`
- `GET /api/voices?provider=:provider_id`
- `GET /api/providers/:provider_id/api-keys`
- `POST /api/providers/:provider_id/api-keys`
- `PUT /api/providers/:provider_id/config`

For detailed field mapping, provider-specific behavior, and compatibility
notes, see [API.md](./API.md).

## Quick Start

### Run Locally

Requirements:

- Node.js 20+
- npm
- Optional MySQL database for persisted provider settings and API keys

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Open the console at:

```text
http://127.0.0.1:4177/
```

Without `DATABASE_URL`, provider settings fall back to in-memory behavior where
supported. Set `DATABASE_URL` when you want configuration, API keys, and voice
records to survive restarts.

### Run With Docker

Build and run the image:

```bash
docker build -t voxout:latest .
docker run --rm -p 4177:4177 \
  -e PORT=4177 \
  -e TTS_AUDIO_DIR=/app/audio \
  -v "$PWD/audio:/app/audio" \
  voxout:latest
```

With MySQL persistence:

```bash
docker run --rm -p 4177:4177 \
  -e PORT=4177 \
  -e DATABASE_URL='mysql://user:password@mysql-host:3306/voxout' \
  -e TTS_AUDIO_DIR=/app/audio \
  -v "$PWD/audio:/app/audio" \
  voxout:latest
```

On startup, the Docker image runs Prisma database synchronization when
`DATABASE_URL` is present, then starts `node dist/server.js`.

## Configuration

Core environment variables:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port, default `4177` |
| `DATABASE_URL` | Optional MySQL connection string for persisted settings |
| `TTS_AUDIO_DIR` | Directory for generated/static audio files |
| `TTS_SYNTHESIS_TIMEOUT_MS` | Optional upstream request timeout override |
| `FREESOUND_API_KEY` | Optional token for `/api/search` Freesound proxy |

Provider credentials are managed through the web console or the
`/api/providers/:provider_id/api-keys` API. API keys are stored separately from
provider config, can be weighted, and are selected at runtime for upstream
requests.

Enable and configure a provider through the API:

```bash
curl -X PUT http://127.0.0.1:4177/api/providers/cambai/config \
  -H 'content-type: application/json' \
  --data '{"enabled":true,"config":{"default_language":"en-us"}}'
```

Add a provider API key:

```bash
curl -X POST http://127.0.0.1:4177/api/providers/cambai/api-keys \
  -H 'content-type: application/json' \
  --data '{"name":"main","api_key":"YOUR_PROVIDER_KEY","weight":1,"enabled":true}'
```

## Examples

### Text to Speech

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/speech \
  -H 'content-type: application/json' \
  --output speech.mp3 \
  --data '{
    "provider": "default",
    "input": "Hello from voxout.",
    "voice": "en-US-JennyNeural",
    "response_format": "mp3"
  }'
```

### Streaming Speech

```bash
curl -N -X POST http://127.0.0.1:4177/v1/audio/speech \
  -H 'content-type: application/json' \
  --output speech.pcm \
  --data '{
    "provider": "mimo",
    "input": "Streaming audio from voxout.",
    "voice": "Chloe",
    "response_format": "pcm",
    "stream_format": "audio"
  }'
```

### Transcription

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/transcriptions \
  -F provider=openai \
  -F model=gpt-4o-transcribe \
  -F response_format=json \
  -F language=auto \
  -F file=@sample.wav
```

### Sound Effects

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/effect \
  -H 'content-type: application/json' \
  --output effect.mp3 \
  --data '{
    "provider": "elevenlabs",
    "instructions": "a short cinematic whoosh",
    "duration_seconds": 1.5,
    "prompt_influence": 0.3,
    "response_format": "mp3"
  }'
```

### Audio Isolation

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/isolation \
  --output isolated.wav \
  -F provider=cambai \
  -F file=@mix.wav \
  -F 'extra_params={"stem":"foreground"}'
```

For Camb.ai, use `{"stem":"background"}` to return the background track.

### Voice Design and Creation

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/voices/design \
  -H 'content-type: application/json' \
  --data '{
    "provider": "elevenlabs",
    "instructions": "A calm narrator voice with a clean tone.",
    "input": "This is a preview sentence.",
    "name": "Calm Narrator"
  }'
```

Then create a stored voice from a selected preview:

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/voices/create \
  -H 'content-type: application/json' \
  --data '{
    "provider": "elevenlabs",
    "generated_voice_id": "preview_voice_id",
    "name": "Calm Narrator",
    "instructions": "A calm narrator voice with a clean tone."
  }'
```

### Voice Cloning

```bash
curl -X POST http://127.0.0.1:4177/v1/audio/voices \
  -F provider=openai \
  -F name='Narrator Clone' \
  -F consent=cons_1234 \
  -F audio_sample=@sample.wav
```

## Frontend Deployment

voxout can serve the compiled frontend itself from `public/`. This is the
simplest deployment: put a reverse proxy in front of the Node service and route
all paths to the same backend.

If you prefer a split deployment, build the frontend and publish `public/` to
any static host:

```bash
npm run build:web
rsync -a --delete public/ /path/to/static/site/
```

Configure `frontend/public/voxout.config.json` before building:

```json
{
  "api_base_url": ""
}
```

Use an empty `api_base_url` when the frontend and API share the same origin.
When the frontend is served from a different origin, set it to the public Voxout
API origin, for example:

```json
{
  "api_base_url": "https://api.example.com"
}
```

Typical reverse proxy rules:

- Same-origin deployment: proxy `/`, `/assets/*`, `/api/*`, `/v1/*`,
  `/audio/*`, and `/health` to the Voxout service.
- Split frontend deployment: serve `/` and `/assets/*` from static hosting, and
  proxy `/api/*`, `/v1/*`, `/audio/*`, and `/health` to the Voxout service.

## Development

Run the full build and test suite:

```bash
npm test
```

Server-only build:

```bash
npm run build:server
```

Frontend-only build:

```bash
npm run build:web
```

Frontend development server:

```bash
npm run dev
```

Project layout:

- `src/`: server, provider adapters, API routing, persistence helpers
- `frontend/`: React console source
- `public/`: compiled frontend assets
- `prisma/`: Prisma schema and migration helpers
- `tests/`: provider and API behavior tests

## Notes

- voxout intentionally normalizes common audio operations while preserving
  provider-specific controls through `extra_params`.
- Some providers expose asynchronous task APIs. Voxout hides the polling flow and
  returns final audio or normalized JSON where possible.
- Upstream pricing, quotas, supported voices, and model availability are owned
  by each provider and can change independently of voxout.

## Acknowledgments

- [Qwen.ai](https://qwen.ai/)
- [Linux.do](https://linux.do)
