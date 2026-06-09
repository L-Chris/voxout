# rebook-tts

Node.js + TypeScript TTS service for rebook.

The service is provider-based. The default `mock` provider returns small WAV
files, so the full reader flow can be tested without a paid TTS account. Real
providers can implement the same `TtsProvider` interface.

## API

- `GET /health`
- `GET /v1/tts/providers`
- `GET /v1/tts/voices?provider=mock`
- `POST /v1/tts/synthesize`
- `POST /v1/tts/jobs`
- `GET /v1/tts/jobs/:id`
- `GET /v1/tts/jobs/:id/segments`
- `GET /v1/tts/audio/:file`

## Development

```bash
npm run build
npm start
```

By default the server listens on `4177` and stores generated audio under
`./audio`.
