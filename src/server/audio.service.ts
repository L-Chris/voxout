import { mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service } from 'typedi'
import {
  getAsrProvider,
  getAudioIsolationProvider,
  getSoundEffectProvider,
  getTtsProvider,
  getVoiceCloneProvider,
  getVoiceDesignProvider,
} from '../providers/registry.js'
import { getProviderTimeoutMs, withTimeout } from '../timeout.js'
import { readMultipartForm, sendBinary, sendJson, sendStream, sendText } from './http.js'
import {
  assertPublicProviderAccess,
  configStore,
  ensureEnabled,
  getRuntimeConfig,
} from './provider-runtime.js'
import { sendAudio as sendStaticAudio } from './static-audio.js'
import { formatVoiceRecord } from './voice-records.js'
import type {
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
  JsonObject,
  JsonValue,
} from '../types.js'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const audioDir = process.env.TTS_AUDIO_DIR ?? join(rootDir, 'audio')
const OPENAI_SPEECH_MODELS = new Set(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'])
const OPENAI_TRANSCRIPTION_MODELS = new Set([
  'whisper-1',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-transcribe-diarize',
])

@Service()
export class AudioService {
  async initialize(): Promise<void> {
    await mkdir(audioDir, { recursive: true })
  }

  createSpeech(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    return handleOpenAiSpeech(body, res)
  }

  createEffect(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    return handleAudioEffect(body, res)
  }

  createIsolation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleAudioIsolation(req, res)
  }

  createVoiceDesign(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    return handleVoiceDesign(body, res)
  }

  createVoice(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleVoice(req, res)
  }

  transcribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleOpenAiTranscription(req, res)
  }

  sendAudio(res: ServerResponse, fileName: string, headOnly = false): Promise<void> {
    return sendStaticAudio(res, audioDir, fileName, headOnly)
  }
}

async function handleOpenAiSpeech(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const target = resolveOpenAiSpeechTarget(body.model, body.provider)
  const providerId = target.providerId
  assertPublicProviderAccess(providerId)
  const input = typeof body.input === 'string' ? body.input : ''
  if (!input.trim()) throw new Error('input is required')

  const provider = getTtsProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)
  const speechFormat = resolveSpeechResponseFormat(provider.id, typeof body.response_format === 'string' ? body.response_format : undefined)
  const stream_format = normalizeSpeechStreamFormat(body.stream_format)
  if (stream_format && speechFormat.conversion) {
    throw new Error(`response_format "${speechFormat.response_format}" requires buffered conversion and is not supported with stream_format`)
  }
  const request = normalizeOpenAiSpeechInput(provider.id, {
    model: target.model,
    input,
    voice: body.voice,
    output_format: speechFormat.providerFormat,
    stream_format,
    speed: typeof body.speed === 'number' ? body.speed : undefined,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    extra_params: normalizeExtraParams(body.extra_params),
  })
  await resolveVoiceForSynthesis(provider.id, request)
  const timeout_ms = getProviderTimeoutMs(context)
  if (stream_format) {
    if (!provider.streamSynthesize) throw new Error(`Provider does not support streaming speech: ${provider.id}`)
    const result = await withTimeout(
      provider.streamSynthesize(request, context),
      timeout_ms,
      `Speech stream creation timed out after ${timeout_ms}ms for provider ${provider.id}`,
    )
    sendStream(res, result.stream, stream_format === 'sse' ? result.mime_type : normalizeSpeechMimeType(speechFormat.response_format, result.mime_type))
    return
  }
  const result = await withTimeout(
    provider.synthesize(request, context),
    timeout_ms,
    `Speech generation timed out after ${timeout_ms}ms for provider ${provider.id}`,
  )
  const output = convertSpeechAudio(result.audio, result.mime_type, speechFormat)
  sendBinary(res, output.audio, output.mime_type)
}

async function handleAudioEffect(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const providerId = getRequiredProvider(body.provider)
  assertPublicProviderAccess(providerId)
  const provider = getSoundEffectProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = normalizeSoundEffectInput(provider.id, body)
  const timeout_ms = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.createSoundEffect(request, context),
    timeout_ms,
    `Sound effect generation timed out after ${timeout_ms}ms for provider ${provider.id}`,
  )
  sendBinary(res, result.audio, result.mime_type)
}

async function handleAudioIsolation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipartForm(req)
  const providerId = getOpenAiModelProvider(form.fields.model, form.fields.provider)
  assertPublicProviderAccess(providerId)
  const provider = getAudioIsolationProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = await normalizeAudioIsolationInput(provider.id, form)
  const timeout_ms = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.isolateAudio(request, context),
    timeout_ms,
    `Audio isolation timed out after ${timeout_ms}ms for provider ${provider.id}`,
  )
  sendBinary(res, result.audio, result.mime_type)
}

async function handleVoiceDesign(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const providerId = getRequiredProvider(body.provider)
  assertPublicProviderAccess(providerId)
  const provider = getVoiceDesignProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = normalizeVoiceDesignInput(provider.id, body)
  const timeout_ms = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.designVoice(request, context),
    timeout_ms,
    `Voice design timed out after ${timeout_ms}ms for provider ${provider.id}`,
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

async function handleVoice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipartForm(req)
  const providerId = typeof form.fields.provider === 'string' && form.fields.provider.trim()
    ? form.fields.provider.trim()
    : 'openai'
  assertPublicProviderAccess(providerId)
  const provider = getVoiceCloneProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = await normalizeVoiceCloneInput(provider.id, form)
  const timeout_ms = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.cloneVoice(request, context),
    timeout_ms,
    `Voice cloning timed out after ${timeout_ms}ms for provider ${provider.id}`,
  )
  const voice = await persistProviderVoice(provider.id, context, result.voice, {
    requestedConsent: request.consent ?? null,
    source: 'audio_sample',
  })
  sendJson(res, {
    id: voice.voice_id,
    object: 'audio.voice',
    created_at: toUnixSeconds(voice.created_at),
    name: voice.name,
  })
}

async function handleOpenAiTranscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipartForm(req)
  const target = resolveOpenAiTranscriptionTarget(form.fields.model, form.fields.provider)
  const providerId = target.providerId
  assertPublicProviderAccess(providerId)
  const provider = getAsrProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const file = form.files.file
  if (!file) throw new Error('file is required')
  const response_format = normalizeTranscriptionResponseFormat(form.fields.response_format)
  const providerResponseFormat = normalizeProviderTranscriptionResponseFormat(provider.id, response_format)
  const stream = normalizeBoolean(form.fields.stream)
  const request: TranscribeRequest = {
    model: target.model,
    file: {
      data: file.data,
      mime_type: normalizeMimeType(file.contentType),
      file_name: file.fileName,
    },
    language: form.fields.language,
    prompt: form.fields.prompt,
    response_format: providerResponseFormat,
    stream,
    extra_params: normalizeExtraParams(form.fields.extra_params ? parseJsonObjectField(form.fields.extra_params, 'extra_params') : undefined),
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

  const timeout_ms = getProviderTimeoutMs(context)
  if (stream) {
    if (!provider.streamTranscribe) throw new Error(`Provider does not support streaming transcription: ${provider.id}`)
    const result = await withTimeout(
      provider.streamTranscribe(request, context),
      timeout_ms,
      `Transcription stream creation timed out after ${timeout_ms}ms for provider ${provider.id}`,
    )
    return sendStream(res, result.stream, result.mime_type)
  }

  const result = await withTimeout(
    provider.transcribe(request, context),
    timeout_ms,
    `Transcription timed out after ${timeout_ms}ms for provider ${provider.id}`,
  )
  const text = result.text ?? ''
  if (response_format === 'text' || response_format === 'srt' || response_format === 'vtt') {
    return sendText(res, formatTranscriptionText(response_format, result), transcriptionTextContentType(response_format))
  }
  if (response_format === 'verbose_json' || response_format === 'diarized_json') {
    return sendJson(res, {
      text,
      segments: result.segments,
      raw: result.raw,
    })
  }
  return sendJson(res, { text })
}

function normalizeOpenAiSpeechInput(providerId: string, input: {
  model?: string
  input: string
  voice?: unknown
  output_format?: string
  stream_format?: 'audio' | 'sse'
  speed?: number
  instructions?: string
  extra_params?: JsonObject
}): SynthesizeRequest {
  const voice = typeof input.voice === 'string' ? input.voice : undefined
  return {
    provider: providerId,
    model: input.model,
    id: randomUUID(),
    text: input.input,
    voice,
    output_format: input.output_format,
    stream_format: input.stream_format,
    speed: input.speed,
    instructions: input.instructions,
    extra_params: input.extra_params,
  }
}

function normalizeAudioIsolationInput(providerId: string, form: Awaited<ReturnType<typeof readMultipartForm>>): AudioIsolationRequest {
  const file = form.files.file
  if (!file) throw new Error('file is required')
  return {
    provider: providerId,
    file: {
      data: file.data,
      mime_type: normalizeMimeType(file.contentType),
      file_name: file.fileName,
    },
    file_format: form.fields.file_format === 'pcm_s16le_16' ? 'pcm_s16le_16' : 'other',
    preview_b64: form.fields.preview_b64,
  }
}

function normalizeSoundEffectInput(providerId: string, input: unknown): SoundEffectRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const prompt = typeof value.input === 'string' ? value.input : ''
  if (!prompt.trim()) throw new Error('input is required')
  return {
    provider: providerId,
    model: typeof value.model === 'string' ? value.model : undefined,
    prompt,
    output_format: typeof value.response_format === 'string' ? value.response_format : undefined,
    duration_seconds: typeof value.duration_seconds === 'number' ? value.duration_seconds : undefined,
    prompt_influence: typeof value.prompt_influence === 'number' ? value.prompt_influence : undefined,
    loop: typeof value.loop === 'boolean' ? value.loop : undefined,
    extra_params: normalizeExtraParams(value.extra_params),
  }
}

function normalizeVoiceDesignInput(providerId: string, input: unknown): VoiceDesignRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const prompt = typeof value.input === 'string' ? value.input : ''
  if (!prompt.trim()) throw new Error('input is required')
  return {
    provider: providerId,
    input: prompt,
    name: typeof value.name === 'string' ? value.name : undefined,
    text: typeof value.text === 'string' ? value.text : undefined,
    output_format: typeof value.response_format === 'string' ? value.response_format : undefined,
    model: typeof value.model === 'string' ? value.model : undefined,
    extra_params: normalizeExtraParams(value.extra_params),
  }
}

async function normalizeVoiceCloneInput(providerId: string, form: Awaited<ReturnType<typeof readMultipartForm>>): Promise<VoiceCloneRequest> {
  const file = form.files.audio_sample
  const name = form.fields.name?.trim()
  if (!name) throw new Error('name is required')
  if (!file) throw new Error('audio_sample is required')
  return {
    provider: providerId,
    name,
    audio_sample: {
      data: file.data,
      mime_type: normalizeMimeType(file.contentType),
      file_name: file.fileName,
    },
    consent: form.fields.consent,
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
  const link = voiceRecord.provider_links.find(item => item.provider_id === providerId)
  if (!link) return
  const resolvedVoice = providerId === 'mimo'
    ? link.preview_audio ?? voiceRecord.preview_audio ?? link.provider_voice_id ?? link.provider_voice_key
    : link.provider_voice_id ?? link.provider_voice_key
  request.voice = resolvedVoice
}

async function persistProviderVoice(
  providerId: string,
  context: Awaited<ReturnType<typeof getRuntimeConfig>>,
  voice: VoicePreview,
  extraMetadata: Record<string, string | number | boolean | null> = {},
): Promise<VoiceRecord> {
  return configStore.upsertVoice({
    voice_id: voice.voice_id,
    name: voice.name,
    description: voice.description,
    language: voice.language,
    preview_mime_type: voice.preview_mime_type,
    preview_audio: voice.preview_audio_data,
    metadata: voice.metadata,
    provider_link: {
      provider_id: providerId,
      provider_account_id: getProviderAccountId(context),
      provider_voice_id: voice.provider_voice_id,
      provider_voice_key: voice.provider_voice_id ?? voice.voice_id,
      preview_mime_type: voice.preview_mime_type,
      preview_audio: voice.preview_audio_data,
      metadata: {
        ...(voice.metadata ?? {}),
        ...extraMetadata,
      },
    },
  })
}

function getProviderAccountId(context: ProviderRuntimeConfig): string {
  const value = context.config.account_id ?? context.config.account_name
  return typeof value === 'string' && value.trim() ? value.trim() : 'default'
}

function toUnixSeconds(value: string | undefined): number {
  if (!value) return Math.floor(Date.now() / 1000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000)
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

function getRequiredProvider(provider: unknown): string {
  const providerId = typeof provider === 'string' ? provider.trim() : ''
  if (!providerId) throw new Error('provider is required')
  return providerId
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue)
  return false
}

function normalizeExtraParams(value: unknown): JsonObject | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new Error('extra_params must be a JSON object')
  }
  return value as JsonObject
}

function parseJsonObjectField(value: string, fieldName: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !isJsonValue(parsed)) {
      throw new Error(`${fieldName} must be a JSON object`)
    }
    return parsed as JsonObject
  } catch (error) {
    if (error instanceof Error && error.message === `${fieldName} must be a JSON object`) throw error
    throw new Error(`${fieldName} must be valid JSON`)
  }
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

function normalizeSpeechMimeType(response_format: string | undefined, providerMimeType: string): string {
  const format = response_format?.toLowerCase()
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'wav') return 'audio/wav'
  if (format === 'pcm') return 'audio/pcm'
  return providerMimeType
}

function resolveSpeechResponseFormat(providerId: string, value: string | undefined): {
  providerFormat?: string
  response_format?: string
  conversion?: 'pcm-to-wav' | 'wav-to-pcm'
  sampleRate?: number
} {
  const format = value?.toLowerCase().trim()
  if (!format) return {}
  if (providerId === 'openai') {
    if (isOpenAiSpeechResponseFormat(format)) return { providerFormat: format, response_format: format }
    throw new Error(`Unsupported response_format for OpenAI speech: ${format}`)
  }
  if (providerId === 'elevenlabs') {
    if (format.startsWith('mp3_') || format.startsWith('pcm_') || format.startsWith('ulaw_')) return { providerFormat: format }
    if (format === 'mp3') return { providerFormat: 'mp3_44100_128', response_format: 'mp3' }
    if (format === 'pcm') return { providerFormat: 'pcm_44100', response_format: 'pcm' }
    if (format === 'wav') return { providerFormat: 'pcm_44100', response_format: 'wav', conversion: 'pcm-to-wav', sampleRate: 44100 }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  if (providerId === 'gradium') {
    if (format === 'opus' || format === 'wav' || format === 'pcm') return { providerFormat: format, response_format: format }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  if (providerId === 'mock') {
    if (format === 'wav') return { providerFormat: 'wav', response_format: 'wav' }
    if (format === 'pcm') return { providerFormat: 'wav', response_format: 'pcm', conversion: 'wav-to-pcm' }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  if (providerId === 'cartesia' || providerId === 'mimo' || providerId === 'default') {
    if (format === 'wav' || format === 'pcm' || format === 'mp3') return { providerFormat: format, response_format: format }
    throw new Error(`Provider ${providerId} cannot synthesize response_format "${format}" without an audio encoder`)
  }
  return { providerFormat: format, response_format: format }
}

function isOpenAiSpeechResponseFormat(format: string): boolean {
  return format === 'mp3' || format === 'opus' || format === 'aac' || format === 'flac' || format === 'wav' || format === 'pcm'
}

function convertSpeechAudio(
  audio: Buffer,
  providerMimeType: string,
  format: { response_format?: string, conversion?: 'pcm-to-wav' | 'wav-to-pcm', sampleRate?: number },
): { audio: Buffer, mime_type: string } {
  if (format.conversion === 'pcm-to-wav') {
    return {
      audio: wrapPcmAsWav(audio, format.sampleRate ?? 44100),
      mime_type: 'audio/wav',
    }
  }
  if (format.conversion === 'wav-to-pcm') {
    return {
      audio: extractWavData(audio),
      mime_type: 'audio/pcm',
    }
  }
  return {
    audio,
    mime_type: normalizeSpeechMimeType(format.response_format, providerMimeType),
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

function normalizeBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1'
}

function normalizeTranscriptionResponseFormat(value: string | undefined): 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json' {
  if (value === 'text' || value === 'srt' || value === 'verbose_json' || value === 'vtt' || value === 'diarized_json') return value
  return 'json'
}

function normalizeProviderTranscriptionResponseFormat(
  providerId: string,
  response_format: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json',
): 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json' {
  if (providerId === 'openai') return response_format
  if (response_format === 'srt' || response_format === 'vtt' || response_format === 'verbose_json' || response_format === 'diarized_json') return 'verbose_json'
  return response_format
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
