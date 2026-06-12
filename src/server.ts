import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ProviderConfigStore } from './config-store.js'
import { loadDotEnv } from './env.js'
import {
  getAsrProvider,
  getAudioIsolationProvider,
  getSoundEffectProvider,
  getTtsProvider,
  getVoiceCloneProvider,
  getVoiceDesignProvider,
  isInternalProviderId,
  listAsrProviders,
  listAudioIsolationProviders,
  listProviderDefinitions,
  listSoundEffectProviders,
  listTtsProviders,
  listVoiceCloneProviders,
  listVoiceDesignProviders,
} from './providers/registry.js'
import { sendPublicFile } from './public.js'
import { getProviderTimeoutMs, withTimeout } from './timeout.js'
import type {
  ProviderConfigInput,
  ProviderRuntimeConfig,
  AudioIsolationRequest,
  SoundEffectRequest,
  SynthesizeRequest,
  TranscribeRequest,
  TranscribeResult,
  VoiceCloneRequest,
  VoiceDesignRequest,
  VoicePreview,
  VoiceRecord,
} from './types.js'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
await loadDotEnv([
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.local'),
  join(rootDir, '.env'),
  join(rootDir, '.env.local'),
])

const port = Number(process.env.PORT ?? 4177)
const audioDir = process.env.TTS_AUDIO_DIR ?? join(rootDir, 'audio')
const publicDir = join(rootDir, 'public')
const configStore = new ProviderConfigStore()
const OPENAI_SPEECH_MODELS = new Set(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'])
const OPENAI_TRANSCRIPTION_MODELS = new Set([
  'whisper-1',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-transcribe-diarize',
])

await mkdir(audioDir, { recursive: true })

const server = createServer(async (req, res) => {
  setCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const isHead = req.method === 'HEAD'
    const isGetLike = req.method === 'GET' || isHead

    if (isGetLike && url.pathname === '/health') {
      return sendJson(res, {
        ok: true,
        database: configStore.isDatabaseEnabled() ? 'enabled' : 'disabled',
      }, 200, isHead)
    }

    if (isGetLike && url.pathname === '/api/providers') {
      const configMap = await getConfigMap()
      return sendJson(res, {
        providers: listProviderDefinitions(configMap),
        database: configStore.isDatabaseEnabled(),
      }, 200, isHead)
    }

    if (isGetLike && url.pathname === '/api/voices') {
      const providerId = url.searchParams.get('provider') ?? undefined
      if (providerId) assertPublicProviderAccess(providerId)
      const voices = (await configStore.listVoices(providerId))
        .filter(voice => voice.links.some(link => canExposeProvider(link.providerId)))
      return sendJson(res, { voices: voices.map(formatVoiceRecord) }, 200, isHead)
    }

    const voicesMatch = /^\/api\/providers\/([^/]+)\/voices$/.exec(url.pathname)
    if (isGetLike && voicesMatch) {
      const providerId = decodeURIComponent(voicesMatch[1] ?? '')
      assertPublicProviderAccess(providerId)
      const provider = getTtsProvider(providerId)
      const context = await getRuntimeConfig(provider.id)
      const voices = mergeVoices(await provider.listVoices(context), await configStore.listVoices(provider.id))
      return sendJson(res, { voices }, 200, isHead)
    }

    if (isGetLike && url.pathname === '/v1/models') {
      return sendJson(res, { object: 'list', data: listOpenAiModels() }, 200, isHead)
    }

    const configMatch = /^\/api\/providers\/([^/]+)\/config$/.exec(url.pathname)
    if (req.method === 'PUT' && configMatch) {
      const providerId = decodeURIComponent(configMatch[1] ?? '')
      assertKnownProvider(providerId)
      assertPublicProviderAccess(providerId)
      const body = await readJson<ProviderConfigInput>(req)
      const record = await configStore.upsertConfig(providerId, body)
      return sendJson(res, { provider: record })
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
      return await createOpenAiSpeech(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/effect') {
      return await createAudioEffect(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/isolation') {
      return await createAudioIsolation(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/design') {
      return await createVoiceDesign(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/voices') {
      return await createVoice(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      return await createOpenAiTranscription(req, res)
    }

    const audioMatch = /^\/audio\/([^/]+)$/.exec(url.pathname)
    if (isGetLike && audioMatch) {
      return sendAudio(res, audioMatch[1] ?? '', isHead)
    }

    if (isGetLike && await sendPublicFile(res, publicDir, url.pathname, isHead)) {
      return
    }

    return sendJson(res, { error: 'Not found' }, 404, isHead)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return sendJson(res, { error: message }, 400, req.method === 'HEAD')
  }
})

server.listen(port, () => {
  console.log(`voxout listening on http://127.0.0.1:${port}`)
})

async function createOpenAiSpeech(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<Record<string, unknown>>(req)
  const target = resolveOpenAiSpeechTarget(body.model, body.provider)
  const providerId = target.providerId
  assertPublicProviderAccess(providerId)
  const input = typeof body.input === 'string' ? body.input : ''
  if (!input.trim()) throw new Error('input is required')

  const provider = getTtsProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)
  const speechFormat = resolveSpeechResponseFormat(provider.id, typeof body.response_format === 'string' ? body.response_format : undefined)
  const streamFormat = normalizeSpeechStreamFormat(body.stream_format)
  if (streamFormat && speechFormat.conversion) {
    throw new Error(`response_format "${speechFormat.responseFormat}" requires buffered conversion and is not supported with stream_format`)
  }
  const request = normalizeOpenAiSpeechInput(provider.id, {
    model: target.model,
    input,
    voice: body.voice,
    outputFormat: speechFormat.providerFormat,
    streamFormat,
    speed: typeof body.speed === 'number' ? body.speed : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
  })
  await resolveVoiceForSynthesis(provider.id, request)
  const timeoutMs = getProviderTimeoutMs(context)
  if (streamFormat) {
    if (!provider.streamSynthesize) throw new Error(`Provider does not support streaming speech: ${provider.id}`)
    const result = await withTimeout(
      provider.streamSynthesize(request, context),
      timeoutMs,
      `Speech stream creation timed out after ${timeoutMs}ms for provider ${provider.id}`,
    )
    sendStream(res, result.stream, streamFormat === 'sse' ? result.mimeType : normalizeSpeechMimeType(speechFormat.responseFormat, result.mimeType))
    return
  }
  const result = await withTimeout(
    provider.synthesize(request, context),
    timeoutMs,
    `Speech generation timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  const output = convertSpeechAudio(result.audio, result.mimeType, speechFormat)
  sendBinary(res, output.audio, output.mimeType)
}

async function createAudioEffect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<Record<string, unknown>>(req)
  const providerId = getOpenAiModelProvider(body.model, body.provider)
  assertPublicProviderAccess(providerId)
  const provider = getSoundEffectProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = normalizeSoundEffectInput(provider.id, body)
  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.createSoundEffect(request, context),
    timeoutMs,
    `Sound effect generation timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  sendBinary(res, result.audio, result.mimeType)
}

async function createAudioIsolation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipartForm(req)
  const providerId = getOpenAiModelProvider(form.fields.model, form.fields.provider)
  assertPublicProviderAccess(providerId)
  const provider = getAudioIsolationProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = await normalizeAudioIsolationInput(provider.id, form)
  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.isolateAudio(request, context),
    timeoutMs,
    `Audio isolation timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  sendBinary(res, result.audio, result.mimeType)
}

async function createVoiceDesign(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<Record<string, unknown>>(req)
  const providerId = getOpenAiModelProvider(body.model, body.provider)
  assertPublicProviderAccess(providerId)
  const provider = getVoiceDesignProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = normalizeVoiceDesignInput(provider.id, body)
  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.designVoice(request, context),
    timeoutMs,
    `Voice design timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  const voices = []
  for (const voice of result.voices) {
    voices.push(await persistProviderVoice(provider.id, context, voice))
  }
  sendJson(res, {
    provider: provider.id,
    text: result.text,
    voices: voices.map(formatVoiceRecord),
  })
}

async function createVoice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipartForm(req)
  const providerId = resolveOpenAiProviderTarget(form.fields.provider, form.fields.model, 'openai', hasVoiceCloneProvider)
  assertPublicProviderAccess(providerId)
  const provider = getVoiceCloneProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = await normalizeVoiceCloneInput(provider.id, form)
  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.cloneVoice(request, context),
    timeoutMs,
    `Voice cloning timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  const voice = await persistProviderVoice(provider.id, context, result.voice, {
    requestedConsent: request.consent ?? null,
    source: 'audio_sample',
  })
  sendJson(res, {
    id: voice.voiceId,
    object: 'audio.voice',
    created_at: toUnixSeconds(voice.createdAt),
    name: voice.name,
  })
}

async function createOpenAiTranscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipartForm(req)
  const target = resolveOpenAiTranscriptionTarget(form.fields.model, form.fields.provider)
  const providerId = target.providerId
  assertPublicProviderAccess(providerId)
  const provider = getAsrProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const file = form.files.file
  const responseFormat = normalizeTranscriptionResponseFormat(form.fields.response_format)
  const providerResponseFormat = normalizeProviderTranscriptionResponseFormat(provider.id, responseFormat)
  const request: TranscribeRequest = {
    model: target.model ?? form.fields.model_id ?? form.fields.asr_model ?? form.fields.asrModel,
    url: form.fields.url,
    audioData: form.fields.audioData,
    mimeType: form.fields.mimeType,
    language: form.fields.language,
    prompt: form.fields.prompt,
    responseFormat: providerResponseFormat,
    format: providerResponseFormat === 'srt'
      ? 'srt'
      : providerResponseFormat === 'vtt'
        ? 'vtt'
        : providerResponseFormat === 'verbose_json'
          ? 'raw'
          : providerResponseFormat === 'diarized_json'
            ? 'diarized_json'
            : 'txt',
  }
  if (file) {
    request.audioData = `data:${normalizeMimeType(file.contentType)};base64,${file.data.toString('base64')}`
    request.mimeType = normalizeMimeType(file.contentType)
  }
  if (!request.url && !request.audioData) {
    throw new Error('file, url, or audioData is required')
  }

  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.transcribe(request, context),
    timeoutMs,
    `Transcription timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  const text = result.text ?? ''
  if (responseFormat === 'text' || responseFormat === 'srt' || responseFormat === 'vtt') {
    return sendText(res, formatTranscriptionText(responseFormat, result), transcriptionTextContentType(responseFormat))
  }
  if (responseFormat === 'verbose_json' || responseFormat === 'diarized_json') {
    return sendJson(res, {
      text,
      segments: result.segments,
      raw: result.raw,
    })
  }
  return sendJson(res, { text })
}

function listOpenAiModels(): Array<{
  id: string
  object: 'model'
  created: number
  owned_by: string
  capabilities: Record<string, boolean>
}> {
  const models = new Map<string, {
    id: string
    object: 'model'
    created: number
    owned_by: string
    capabilities: Record<string, boolean>
  }>()
  for (const provider of [
    ...listTtsProviders(),
    ...listAsrProviders(),
    ...listSoundEffectProviders(),
    ...listAudioIsolationProviders(),
    ...listVoiceDesignProviders(),
    ...listVoiceCloneProviders(),
  ].filter(provider => !isInternalProviderId(provider.id))) {
    const existing = models.get(provider.id)
    models.set(provider.id, {
      id: provider.id,
      object: 'model',
      created: 0,
      owned_by: 'voxout',
      capabilities: {
        ...(existing?.capabilities ?? {}),
        ...(provider.capabilities ?? {}),
      },
    })
  }
  return [...models.values()]
}

function canExposeProvider(providerId: string): boolean {
  return allowInternalProviders() || !isInternalProviderId(providerId)
}

function assertPublicProviderAccess(providerId: string): void {
  if (!canExposeProvider(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`)
  }
}

function allowInternalProviders(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VOXOUT_EXPOSE_INTERNAL_PROVIDERS === '1'
}

async function getConfigMap(): Promise<Map<string, ProviderRuntimeConfig>> {
  const records = await configStore.listConfigs()
  return new Map(records.map(record => [record.providerId, record]))
}

async function getRuntimeConfig(providerId: string): Promise<ProviderRuntimeConfig> {
  return configStore.getConfig(providerId)
}

function ensureEnabled(providerId: string, context: ProviderRuntimeConfig): void {
  if (!context.enabled) throw new Error(`Provider is disabled: ${providerId}`)
}

function assertKnownProvider(providerId: string): void {
  try {
    getTtsProvider(providerId)
    return
  } catch {
    try {
      getAsrProvider(providerId)
      return
    } catch {
      try {
        getSoundEffectProvider(providerId)
        return
      } catch {
        try {
          getAudioIsolationProvider(providerId)
          return
        } catch {
          try {
            getVoiceDesignProvider(providerId)
            return
          } catch {
            getVoiceCloneProvider(providerId)
          }
        }
      }
    }
  }
}

function normalizeOpenAiSpeechInput(providerId: string, input: {
  model?: string
  input: string
  voice?: unknown
  outputFormat?: string
  streamFormat?: 'audio' | 'sse'
  speed?: number
  instructions?: string
}): SynthesizeRequest {
  const voice = typeof input.voice === 'string' ? input.voice : undefined
  return {
    provider: providerId,
    model: input.model,
    id: randomUUID(),
    text: input.input,
    voice,
    outputFormat: input.outputFormat,
    streamFormat: input.streamFormat,
    speed: input.speed,
    instructions: input.instructions,
  }
}

async function normalizeAudioIsolationInput(providerId: string, form: Awaited<ReturnType<typeof readMultipartForm>>): Promise<AudioIsolationRequest> {
  const file = form.files.audio ?? form.files.file
  const audioSource = form.fields.audioData
  const url = form.fields.url
  if (!file && !audioSource && !url) throw new Error('audio file, url, or audioData is required')
  if (url && !file && !audioSource) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download audio for isolation: ${response.status}`)
    const audio = Buffer.from(await response.arrayBuffer())
    return {
      provider: providerId,
      audioData: `data:${normalizeMimeType(response.headers.get('content-type') ?? undefined)};base64,${audio.toString('base64')}`,
      mimeType: normalizeMimeType(response.headers.get('content-type') ?? undefined),
      fileFormat: form.fields.file_format === 'pcm_s16le_16' ? 'pcm_s16le_16' : 'other',
      previewBase64: form.fields.preview_b64,
    }
  }
  return {
    provider: providerId,
    audioData: file
      ? `data:${normalizeMimeType(file.contentType)};base64,${file.data.toString('base64')}`
      : audioSource,
    mimeType: file ? normalizeMimeType(file.contentType) : form.fields.mimeType,
    fileFormat: form.fields.file_format === 'pcm_s16le_16' ? 'pcm_s16le_16' : 'other',
    previewBase64: form.fields.preview_b64,
  }
}

function normalizeSoundEffectInput(providerId: string, input: unknown): SoundEffectRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const prompt = typeof value.input === 'string'
    ? value.input
    : typeof value.prompt === 'string'
      ? value.prompt
      : ''
  if (!prompt.trim()) throw new Error('input is required')
  return {
    provider: providerId,
    prompt,
    outputFormat: typeof value.response_format === 'string'
      ? value.response_format
      : typeof value.output_format === 'string'
        ? value.output_format
        : undefined,
    durationSeconds: typeof value.duration_seconds === 'number'
      ? value.duration_seconds
      : typeof value.durationSeconds === 'number'
        ? value.durationSeconds
        : undefined,
    promptInfluence: typeof value.prompt_influence === 'number'
      ? value.prompt_influence
      : typeof value.promptInfluence === 'number'
        ? value.promptInfluence
        : undefined,
    loop: typeof value.loop === 'boolean' ? value.loop : undefined,
  }
}

function normalizeVoiceDesignInput(providerId: string, input: unknown): VoiceDesignRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const voiceDescription = typeof value.voice_description === 'string'
    ? value.voice_description
    : typeof value.voiceDescription === 'string'
      ? value.voiceDescription
      : typeof value.input === 'string'
        ? value.input
        : ''
  if (!voiceDescription.trim()) throw new Error('voice_description is required')
  return {
    provider: providerId,
    voiceDescription,
    name: typeof value.name === 'string' ? value.name : typeof value.voice_name === 'string' ? value.voice_name : undefined,
    text: typeof value.text === 'string' ? value.text : undefined,
    outputFormat: typeof value.response_format === 'string'
      ? value.response_format
      : typeof value.output_format === 'string'
        ? value.output_format
        : undefined,
    model: typeof value.model_id === 'string' ? value.model_id : undefined,
    autoGenerateText: typeof value.auto_generate_text === 'boolean' ? value.auto_generate_text : undefined,
    loudness: typeof value.loudness === 'number' ? value.loudness : undefined,
    seed: typeof value.seed === 'number' ? value.seed : undefined,
    guidanceScale: typeof value.guidance_scale === 'number' ? value.guidance_scale : undefined,
    quality: typeof value.quality === 'number' ? value.quality : undefined,
    referenceAudioData: typeof value.reference_audio_base64 === 'string' ? value.reference_audio_base64 : undefined,
    promptStrength: typeof value.prompt_strength === 'number' ? value.prompt_strength : undefined,
  }
}

async function normalizeVoiceCloneInput(providerId: string, form: Awaited<ReturnType<typeof readMultipartForm>>): Promise<VoiceCloneRequest> {
  const file = form.files.audio_sample ?? form.files.audio ?? form.files.file
  const name = form.fields.name?.trim()
  const url = form.fields.url?.trim()
  if (!name) throw new Error('name is required')
  if (!file && !form.fields.audioData && !url) throw new Error('audio_sample file, url, or audioData is required')
  if (!file && !form.fields.audioData && url) {
    return resolveVoiceCloneUrl(providerId, form, url, name)
  }
  return {
    provider: providerId,
    name,
    audioData: file
      ? `data:${normalizeMimeType(file.contentType)};base64,${file.data.toString('base64')}`
      : form.fields.audioData,
    mimeType: file ? normalizeMimeType(file.contentType) : form.fields.mimeType,
    fileName: file?.fileName,
    consent: form.fields.consent,
    description: form.fields.description,
    language: form.fields.language,
    previewText: form.fields.preview_text,
  }
}

async function resolveVoiceCloneUrl(
  providerId: string,
  form: Awaited<ReturnType<typeof readMultipartForm>>,
  url: string,
  name: string,
): Promise<VoiceCloneRequest> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to download audio for voice clone: ${response.status}`)
  const audio = Buffer.from(await response.arrayBuffer())
  const mimeType = normalizeMimeType(response.headers.get('content-type') ?? undefined)
  return {
    provider: providerId,
    name,
    audioData: `data:${mimeType};base64,${audio.toString('base64')}`,
    mimeType,
    fileName: getFileNameFromUrl(url),
    consent: form.fields.consent,
    description: form.fields.description,
    language: form.fields.language,
    previewText: form.fields.preview_text,
  }
}

async function resolveVoiceForSynthesis(providerId: string, request: SynthesizeRequest): Promise<void> {
  const voice = request.voice
  if (!voice) return
  if (providerId !== 'openai' && providerId !== 'elevenlabs' && providerId !== 'mimo' && providerId !== 'cartesia' && providerId !== 'gradium') {
    return
  }
  const voiceRecord = await configStore.getVoice(providerId, voice)
  if (!voiceRecord) return
  const link = voiceRecord.links.find(item => item.providerId === providerId)
  if (!link) return
  const resolvedVoice = providerId === 'mimo'
    ? link.previewAudio ?? voiceRecord.previewAudio ?? link.providerVoiceId ?? link.providerVoiceKey
    : link.providerVoiceId ?? link.providerVoiceKey
  request.voice = resolvedVoice
}

function mergeVoices(providerVoices: Array<{ id: string, name: string, locale?: string, gender?: string, provider: string }>, storedVoices: VoiceRecord[]) {
  const byId = new Map(providerVoices.map(voice => [voice.id, voice]))
  for (const voice of storedVoices) {
    const link = voice.links.find(item => item.providerId === providerVoices[0]?.provider) ?? voice.links[0]
    const id = link?.providerVoiceId ?? link?.providerVoiceKey ?? voice.voiceId
    byId.set(id, {
      id,
      name: voice.name,
      locale: voice.language,
      provider: link?.providerId ?? 'voxout',
    })
  }
  return [...byId.values()]
}

function formatVoiceRecord(voice: VoiceRecord) {
  return {
    id: voice.id,
    voice_id: voice.voiceId,
    name: voice.name,
    description: voice.description,
    language: voice.language,
    preview_mime_type: voice.previewMimeType,
    preview_audio: voice.previewAudio,
    metadata: voice.metadata,
    provider_links: voice.links.map(link => ({
      id: link.id,
      provider: link.providerId,
      provider_account_id: link.providerAccountId,
      provider_voice_id: link.providerVoiceId,
      provider_voice_key: link.providerVoiceKey,
      preview_mime_type: link.previewMimeType,
      preview_audio: link.previewAudio,
      metadata: link.metadata,
      created_at: link.createdAt,
      updated_at: link.updatedAt,
    })),
    created_at: voice.createdAt,
    updated_at: voice.updatedAt,
  }
}

async function persistProviderVoice(
  providerId: string,
  context: ProviderRuntimeConfig,
  voice: VoicePreview,
  extraMetadata: Record<string, string | number | boolean | null> = {},
): Promise<VoiceRecord> {
  return configStore.upsertVoice({
    voiceId: voice.voiceId,
    name: voice.name,
    description: voice.description,
    language: voice.language,
    previewMimeType: voice.previewMimeType,
    previewAudio: voice.previewAudioData,
    metadata: voice.metadata,
    providerLink: {
      providerId,
      providerAccountId: getProviderAccountId(context),
      providerVoiceId: voice.providerVoiceId,
      providerVoiceKey: voice.providerVoiceId ?? voice.voiceId,
      previewMimeType: voice.previewMimeType,
      previewAudio: voice.previewAudioData,
      metadata: {
        ...(voice.metadata ?? {}),
        ...extraMetadata,
      },
    },
  })
}

function getProviderAccountId(context: ProviderRuntimeConfig): string {
  const value = context.config.accountId ?? context.config.accountName
  return typeof value === 'string' && value.trim() ? value.trim() : 'default'
}

function toUnixSeconds(value: string | undefined): number {
  if (!value) return Math.floor(Date.now() / 1000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000)
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS')
}

function sendJson(res: ServerResponse, value: unknown, status = 200, headOnly = false): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(headOnly ? undefined : body)
}

function sendText(res: ServerResponse, value: string, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(value)),
  })
  res.end(value)
}

function sendBinary(res: ServerResponse, value: Buffer, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(value.length),
  })
  res.end(value)
}

function sendStream(res: ServerResponse, stream: ReadableStream<Uint8Array>, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
  })
  Readable.fromWeb(stream).on('error', error => res.destroy(error)).pipe(res)
}

async function sendAudio(res: ServerResponse, fileName: string, headOnly = false): Promise<void> {
  if (!/^[a-f0-9]{64}\.(?:wav|mp3)$/.test(fileName)) {
    sendJson(res, { error: 'Invalid audio file name' }, 400, headOnly)
    return
  }
  const filePath = normalize(join(audioDir, fileName))
  if (!filePath.startsWith(normalize(audioDir))) {
    sendJson(res, { error: 'Invalid audio path' }, 400, headOnly)
    return
  }
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) {
    sendJson(res, { error: 'Audio not found' }, 404, headOnly)
    return
  }
  res.writeHead(200, {
    'content-type': fileName.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
    'content-length': String(fileStat.size),
  })
  if (headOnly) {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text || '{}') as T
}

async function readMultipartForm(req: IncomingMessage): Promise<{
  fields: Record<string, string>
  files: Record<string, { fileName: string, contentType: string, data: Buffer }>
}> {
  const contentType = req.headers['content-type'] ?? ''
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[1]
    ?? /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[2]
  if (!boundary) throw new Error('multipart/form-data boundary is required')
  const body = await readRequestBuffer(req)
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  const files: Record<string, { fileName: string, contentType: string, data: Buffer }> = {}
  let cursor = body.indexOf(boundaryBuffer)

  while (cursor >= 0) {
    cursor += boundaryBuffer.length
    if (body[cursor] === 45 && body[cursor + 1] === 45) break
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) break
    const headers = body.slice(cursor, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
    if (nextBoundary < 0) break
    const data = body.slice(dataStart, nextBoundary)
    const disposition = /^content-disposition:\s*([^\r\n]+)/im.exec(headers)?.[1] ?? ''
    const name = /name="([^"]+)"/.exec(disposition)?.[1]
    const fileName = /filename="([^"]*)"/.exec(disposition)?.[1]
    const partContentType = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? 'application/octet-stream'
    if (name && fileName != null) {
      files[name] = { fileName, contentType: partContentType, data }
    } else if (name) {
      fields[name] = data.toString('utf8')
    }
    cursor = body.indexOf(boundaryBuffer, nextBoundary + 2)
  }
  return { fields, files }
}

async function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function getOpenAiModelProvider(model: unknown, provider: unknown): string {
  const providerId = typeof provider === 'string' && provider.trim()
    ? provider.trim()
    : typeof model === 'string' && model.trim()
      ? model.trim()
      : ''
  if (!providerId) throw new Error('model is required')
  return providerId
}

function resolveOpenAiProviderTarget(
  provider: unknown,
  legacyModel: unknown,
  defaultProviderId: string,
  hasProvider: (id: string) => boolean,
): string {
  const explicitProvider = typeof provider === 'string' ? provider.trim() : ''
  if (explicitProvider) return explicitProvider
  const legacyProvider = typeof legacyModel === 'string' ? legacyModel.trim() : ''
  if (legacyProvider && hasProvider(legacyProvider)) return legacyProvider
  return defaultProviderId
}

function resolveOpenAiSpeechTarget(model: unknown, provider: unknown): { providerId: string, model?: string } {
  const modelId = typeof model === 'string' ? model.trim() : ''
  const explicitProvider = typeof provider === 'string' ? provider.trim() : ''
  if (explicitProvider) {
    return { providerId: explicitProvider, model: modelId || undefined }
  }
  if (!modelId) throw new Error('model is required')
  if (hasTtsProvider(modelId)) {
    return { providerId: modelId }
  }
  if (OPENAI_SPEECH_MODELS.has(modelId)) {
    return { providerId: 'openai', model: modelId }
  }
  return { providerId: 'openai', model: modelId }
}

function resolveOpenAiTranscriptionTarget(model: unknown, provider: unknown): { providerId: string, model?: string } {
  const modelId = typeof model === 'string' ? model.trim() : ''
  const explicitProvider = typeof provider === 'string' ? provider.trim() : ''
  if (explicitProvider) {
    return { providerId: explicitProvider, model: modelId || undefined }
  }
  if (!modelId) throw new Error('model is required')
  if (hasAsrProvider(modelId)) {
    return { providerId: modelId }
  }
  if (OPENAI_TRANSCRIPTION_MODELS.has(modelId)) {
    return { providerId: 'openai', model: modelId }
  }
  return { providerId: 'openai', model: modelId }
}

function hasTtsProvider(id: string): boolean {
  try {
    getTtsProvider(id)
    return true
  } catch {
    return false
  }
}

function hasAsrProvider(id: string): boolean {
  try {
    getAsrProvider(id)
    return true
  } catch {
    return false
  }
}

function hasVoiceCloneProvider(id: string): boolean {
  try {
    getVoiceCloneProvider(id)
    return true
  } catch {
    return false
  }
}

function normalizeSpeechMimeType(responseFormat: string | undefined, providerMimeType: string): string {
  const format = responseFormat?.toLowerCase()
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'wav') return 'audio/wav'
  if (format === 'pcm') return 'audio/pcm'
  return providerMimeType
}

function resolveSpeechResponseFormat(providerId: string, value: string | undefined): {
  providerFormat?: string
  responseFormat?: string
  conversion?: 'pcm-to-wav' | 'wav-to-pcm'
  sampleRate?: number
} {
  const format = value?.toLowerCase().trim()
  if (!format) return {}
  if (providerId === 'openai') {
    if (isOpenAiSpeechResponseFormat(format)) return { providerFormat: format, responseFormat: format }
    throw new Error(`Unsupported response_format for OpenAI speech: ${format}`)
  }
  if (providerId === 'elevenlabs') {
    if (format.startsWith('mp3_') || format.startsWith('pcm_') || format.startsWith('ulaw_')) return { providerFormat: format }
    if (format === 'mp3') return { providerFormat: 'mp3_44100_128', responseFormat: 'mp3' }
    if (format === 'pcm') return { providerFormat: 'pcm_44100', responseFormat: 'pcm' }
    if (format === 'wav') return { providerFormat: 'pcm_44100', responseFormat: 'wav', conversion: 'pcm-to-wav', sampleRate: 44100 }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  if (providerId === 'gradium') {
    if (format === 'opus' || format === 'wav' || format === 'pcm') return { providerFormat: format, responseFormat: format }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  if (providerId === 'mock') {
    if (format === 'wav') return { providerFormat: 'wav', responseFormat: 'wav' }
    if (format === 'pcm') return { providerFormat: 'wav', responseFormat: 'pcm', conversion: 'wav-to-pcm' }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  if (providerId === 'cartesia' || providerId === 'mimo' || providerId === 'default') {
    if (format === 'wav' || format === 'pcm' || format === 'mp3') return { providerFormat: format, responseFormat: format }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  return { providerFormat: format, responseFormat: format }
}

function isOpenAiSpeechResponseFormat(format: string): boolean {
  return format === 'mp3' || format === 'opus' || format === 'aac' || format === 'flac' || format === 'wav' || format === 'pcm'
}

function convertSpeechAudio(
  audio: Buffer,
  providerMimeType: string,
  format: { responseFormat?: string, conversion?: 'pcm-to-wav' | 'wav-to-pcm', sampleRate?: number },
): { audio: Buffer, mimeType: string } {
  if (format.conversion === 'pcm-to-wav') {
    return {
      audio: wrapPcmAsWav(audio, format.sampleRate ?? 44100),
      mimeType: 'audio/wav',
    }
  }
  if (format.conversion === 'wav-to-pcm') {
    return {
      audio: extractWavData(audio),
      mimeType: 'audio/pcm',
    }
  }
  return {
    audio,
    mimeType: normalizeSpeechMimeType(format.responseFormat, providerMimeType),
  }
}

function wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = channels * bitsPerSample / 8
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function extractWavData(wav: Buffer): Buffer {
  if (wav.subarray(0, 4).toString('ascii') !== 'RIFF' || wav.subarray(8, 12).toString('ascii') !== 'WAVE') return wav
  let offset = 12
  while (offset + 8 <= wav.length) {
    const chunkId = wav.subarray(offset, offset + 4).toString('ascii')
    const chunkSize = wav.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkSize
    if (chunkId === 'data') return wav.subarray(chunkStart, Math.min(chunkEnd, wav.length))
    offset = chunkEnd + (chunkSize % 2)
  }
  return wav
}

function normalizeSpeechStreamFormat(value: unknown): 'audio' | 'sse' | undefined {
  if (value == null || value === '') return undefined
  if (value === 'audio' || value === 'sse') return value
  throw new Error('stream_format must be "audio" or "sse"')
}

function normalizeTranscriptionResponseFormat(value: string | undefined): 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json' {
  if (value === 'text' || value === 'srt' || value === 'verbose_json' || value === 'vtt' || value === 'diarized_json') return value
  return 'json'
}

function normalizeProviderTranscriptionResponseFormat(
  providerId: string,
  responseFormat: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json',
): 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json' {
  if (providerId === 'openai') return responseFormat
  if (responseFormat === 'srt' || responseFormat === 'vtt' || responseFormat === 'verbose_json' || responseFormat === 'diarized_json') return 'verbose_json'
  return responseFormat
}

function transcriptionTextContentType(format: 'text' | 'srt' | 'vtt'): string {
  if (format === 'vtt') return 'text/vtt; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

function formatTranscriptionText(format: 'text' | 'srt' | 'vtt', result: TranscribeResult): string {
  if (format === 'text') return result.text ?? ''
  const segments = result.segments ?? []
  if (!segments.length) return result.text ?? ''
  if (format === 'vtt') {
    return `WEBVTT\n\n${segments.map((segment, index) => [
      String(index + 1),
      `${formatVttTimestamp(segment.from)} --> ${formatVttTimestamp(segment.to)}`,
      segment.content,
    ].join('\n')).join('\n\n')}\n`
  }
  return `${segments.map((segment, index) => [
    String(index + 1),
    `${formatSrtTimestamp(segment.from)} --> ${formatSrtTimestamp(segment.to)}`,
    segment.content,
  ].join('\n')).join('\n\n')}\n`
}

function formatSrtTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
}

function formatVttTimestamp(seconds: number): string {
  return formatSrtTimestamp(seconds).replace(',', '.')
}

function normalizeMimeType(value: string | undefined): string {
  return value?.split(';')[0]?.trim() || 'application/octet-stream'
}

function getFileNameFromUrl(value: string): string {
  try {
    const pathname = new URL(value).pathname
    const name = pathname.split('/').filter(Boolean).pop()
    return name || 'audio-sample'
  } catch {
    return 'audio-sample'
  }
}
