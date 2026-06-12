# voxout

Node.js + TypeScript TTS service for rebook.

The service is provider-based. It includes:

- `edge`: Microsoft Edge online TTS through `node-edge-tts`, returning MP3.
- `mimo`: Xiaomi MiMo V2.5 TTS through the MiMo chat-completions API, returning WAV by default.
- `elevenlabs`: ElevenLabs text-to-sound-effects provider, returning MP3.
- `mock`: local WAV tone output for development and tests without network.

Additional providers can implement the same `TtsProvider` interface. Providers
may expose lightweight `capabilities`; for example `mimo` reports
`voiceDesign: true`, which lets rebook plan designed voices without hard-coding
one provider name.

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

The `edge` provider loads the full Edge ReadAloud voice catalog from Microsoft
and caches it in memory. The voice list falls back to a small built-in set if
the remote catalog is unavailable.

Optional environment variables:

- `MIMO_API_KEY`: required when using the `mimo` provider.
- `MIMO_BASE_URL`: MiMo API base URL, default `https://api.xiaomimimo.com/v1`.
- `MIMO_TTS_MODEL`: preset-voice synthesis model, default `mimo-v2.5-tts`.
- `MIMO_VOICE_DESIGN_MODEL`: text voice-design synthesis model, default `mimo-v2.5-tts-voicedesign`.
- `MIMO_VOICE_CLONE_MODEL`: sample voice-clone synthesis model, default `mimo-v2.5-tts-voiceclone`.
- `MIMO_VOICE_SAMPLE_TEXT`: short text used once to create a reusable voice-design sample for a role card.
- `MIMO_TTS_FORMAT`: `wav` or `mp3`, default `wav`.
- `MIMO_TTS_TIMEOUT_MS`: MiMo request timeout, default `TTS_SYNTHESIS_TIMEOUT_MS` or `45000`.
- `MIMO_OPTIMIZE_TEXT_PREVIEW`: passed to voice-design requests, default `true`.
- `EDGE_TTS_VOICES_CACHE_MS`: voice catalog cache TTL, default `86400000`.
- `EDGE_TTS_VOICES_TIMEOUT_MS`: voice catalog request timeout, default `10000`.
- `EDGE_TTS_VOICES_URL`: override the Edge voice catalog endpoint.
- `EDGE_TTS_TRUSTED_CLIENT_TOKEN`: override the Edge trusted client token.
- `EDGE_TTS_TIMEOUT_MS`: synthesis timeout, default `30000`.
- `EDGE_TTS_PROXY`: proxy passed to `node-edge-tts`.
- `ELEVENLABS_API_KEY`: required when using the `elevenlabs` sound effect provider.
- `ELEVENLABS_BASE_URL`: ElevenLabs API base URL, default `https://api.elevenlabs.io/v1`.
- `ELEVENLABS_SOUND_EFFECT_MODEL`: sound effects model, default `eleven_text_to_sound_v2`.
- `ELEVENLABS_SOUND_EFFECT_OUTPUT_FORMAT`: output format query parameter, default `mp3_44100_128`.
- `ELEVENLABS_SOUND_EFFECT_DURATION_SECONDS`: optional default sound duration, 0.5 to 30 seconds. A segment-level `soundEffectDurationSeconds` overrides it.
- `ELEVENLABS_SOUND_EFFECT_PROMPT_INFLUENCE`: optional prompt influence, default `0.3`.
- `ELEVENLABS_SOUND_EFFECT_LOOP`: optional loop flag, default unset unless configured.
- `TTS_SYNTHESIS_RETRIES`: per-segment job retry count, default `1`.
- `TTS_SYNTHESIS_RETRY_BASE_DELAY_MS`: retry base delay for ordinary errors, default `750`.
- `TTS_SYNTHESIS_RATE_LIMIT_RETRY_BASE_DELAY_MS`: retry base delay for rate-limit errors, default `3000`.
- `TTS_SYNTHESIS_RETRY_MAX_DELAY_MS`: retry max delay, default `15000`.
- `TTS_SYNTHESIS_TIMEOUT_MS`: generic per-segment timeout, default `45000`.

```bash
curl -X POST http://127.0.0.1:4177/v1/tts/synthesize \
  -H 'content-type: application/json' \
  --data '{"provider":"edge","voice":"zh-CN-XiaoyiNeural","segment":{"id":"demo","text":"你好，rebook TTS。"}}'
```

```bash
curl -X POST http://127.0.0.1:4177/v1/tts/synthesize \
  -H 'content-type: application/json' \
  --data '{"provider":"mimo","voice":"冰糖","segment":{"id":"demo","text":"你好，rebook TTS。"}}'
```

For MiMo character voice design, pass a short `voicePrompt` on the segment. The
service first creates and caches a voice-design sample for that prompt, then
synthesizes the target text with `mimo-v2.5-tts-voiceclone` so later segments
with the same role card keep the same voice.

```bash
curl -X POST http://127.0.0.1:4177/v1/tts/synthesize \
  -H 'content-type: application/json' \
  --data '{"provider":"mimo","segment":{"id":"demo","text":"别动。","voicePrompt":"年轻男性，冷静克制，嗓音清亮但带一点紧张感。"}}'
```

Sound effects can be generated directly with ElevenLabs:

```bash
curl -X POST http://127.0.0.1:4177/v1/tts/synthesize \
  -H 'content-type: application/json' \
  --data '{"provider":"elevenlabs","segment":{"id":"sfx-demo","text":"汪！","soundEffectPrompt":"a short dog bark in a quiet street","soundEffectDurationSeconds":0.8}}'
```

Jobs may mix providers by setting `segment.provider`; this is how rebook keeps
normal narration/dialogue on the selected TTS provider while routing effect
segments to `elevenlabs`.
