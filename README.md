# voxout

Provider gateway for speech synthesis, sound effects, and ASR.

voxout exposes one provider configuration surface and one invocation API. It
stores provider settings in MySQL through Prisma; provider keys, base URLs, and
model choices should be managed from the web console or inserted into the
`ProviderConfig` table.

## Providers

- `mock`: local WAV TTS for development and tests.
- `edge`: Microsoft Edge online TTS.
- `mimo`: Xiaomi MiMo TTS with preset voices and voice design.
- `elevenlabs`: ElevenLabs sound-effects generation.
- `mock-asr`: local ASR stub for development.
- `bilibili-asr`: ASR through the `bilibili-mcp` Flask API.

## API

- `GET /health`
- `GET /api/providers`
- `PUT /api/providers/:providerId/config`
- `POST /api/invoke`
- `GET /audio/:file`

The old `/v1/tts/*` API has been removed.

## Invoke

TTS and sound effects:

```bash
curl -X POST http://127.0.0.1:4177/api/invoke \
  -H 'content-type: application/json' \
  --data '{"provider":"edge","operation":"synthesize","input":{"text":"你好，voxout。","voice":"zh-CN-XiaoyiNeural"}}'
```

ASR:

```bash
curl -X POST http://127.0.0.1:4177/api/invoke \
  -H 'content-type: application/json' \
  --data '{"provider":"bilibili-asr","operation":"transcribe","input":{"url":"https://example.com/audio.m4a","format":"txt"}}'
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

Set `DATABASE_URL` to enable persisted provider settings. Deployment
environment variables are limited to service-level settings such as port,
database URL, audio storage, and global synthesis timeout.
