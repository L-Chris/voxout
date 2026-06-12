export interface TtsVoice {
  id: string
  name: string
  locale?: string
  gender?: string
  provider: string
  capabilities?: TtsProviderCapabilities
}

export interface TtsProviderCapabilities {
  tts?: boolean
  ttsStreaming?: boolean
  asr?: boolean
  voiceDesign?: boolean
  voiceClone?: boolean
  soundEffects?: boolean
  isolation?: boolean
}

export type ProviderCapabilities = TtsProviderCapabilities

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export interface ProviderContext {
  enabled?: boolean
  config?: JsonObject
  secrets?: JsonObject
}

export interface ProviderFieldDefinition {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'url'
  secret?: boolean
  placeholder?: string
  description?: string
  options?: string[]
}

export interface ProviderDefinition {
  id: string
  name: string
  capabilities?: ProviderCapabilities
  fields?: ProviderFieldDefinition[]
  enabled: boolean
  configured: boolean
  config: JsonObject
  secrets: JsonObject
}

export interface SynthesizeRequest {
  provider?: string
  model?: string
  id?: string
  text: string
  voice?: string
  lang?: string
  outputFormat?: string
  streamFormat?: 'audio' | 'sse'
  speed?: number
  pitch?: string
  volume?: string
  instructions?: string
}

export interface TtsProvider {
  readonly id: string
  readonly name: string
  readonly capabilities?: ProviderCapabilities
  readonly fields?: ProviderFieldDefinition[]
  listVoices(context?: ProviderContext): Promise<TtsVoice[]>
  synthesize(request: SynthesizeRequest, context?: ProviderContext): Promise<{
    audio: Buffer
    mimeType: string
    durationMs: number
  }>
  streamSynthesize?(request: SynthesizeRequest, context?: ProviderContext): Promise<{
    stream: ReadableStream<Uint8Array>
    mimeType: string
  }>
}

export interface TranscribeRequest {
  provider?: string
  model?: string
  url?: string
  audioData?: string
  mimeType?: string
  language?: string
  prompt?: string
  responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json'
  format?: 'txt' | 'srt' | 'vtt' | 'raw' | 'diarized_json'
}

export interface TranscribeSegment {
  from: number
  to: number
  content: string
}

export interface TranscribeResult {
  provider: string
  format: string
  text?: string
  segments?: TranscribeSegment[]
  raw?: unknown
}

export interface SoundEffectRequest {
  provider?: string
  model?: string
  prompt: string
  outputFormat?: string
  durationSeconds?: number
  promptInfluence?: number
  loop?: boolean
}

export interface AudioIsolationRequest {
  provider?: string
  audioData: string
  mimeType?: string
  fileFormat?: 'pcm_s16le_16' | 'other'
  previewBase64?: string
}

export interface VoiceDesignRequest {
  provider?: string
  input: string
  name?: string
  text?: string
  outputFormat?: string
  model?: string
  providerOptions?: JsonObject
}

export interface VoiceCloneRequest {
  provider?: string
  name: string
  audioData: string
  mimeType?: string
  fileName?: string
  consent?: string
  description?: string
  language?: string
  previewText?: string
  metadata?: JsonObject
}

export interface VoicePreview {
  voiceId: string
  providerVoiceId?: string
  name: string
  description?: string
  language?: string
  previewAudioData?: string
  previewMimeType?: string
  durationSeconds?: number
  metadata?: JsonObject
}

export interface VoiceDesignResult {
  provider: string
  text?: string
  voices: VoicePreview[]
  raw?: unknown
}

export interface VoiceCloneResult {
  provider: string
  voice: VoicePreview
  raw?: unknown
}

export interface AudioGenerationResult {
  audio: Buffer
  mimeType: string
  durationMs: number
}

export interface AsrProvider {
  readonly id: string
  readonly name: string
  readonly capabilities?: ProviderCapabilities
  readonly fields?: ProviderFieldDefinition[]
  transcribe(request: TranscribeRequest, context?: ProviderContext): Promise<TranscribeResult>
}

export interface SoundEffectProvider {
  readonly id: string
  readonly name: string
  readonly capabilities?: ProviderCapabilities
  readonly fields?: ProviderFieldDefinition[]
  createSoundEffect(request: SoundEffectRequest, context?: ProviderContext): Promise<AudioGenerationResult>
}

export interface AudioIsolationProvider {
  readonly id: string
  readonly name: string
  readonly capabilities?: ProviderCapabilities
  readonly fields?: ProviderFieldDefinition[]
  isolateAudio(request: AudioIsolationRequest, context?: ProviderContext): Promise<AudioGenerationResult>
}

export interface VoiceDesignProvider {
  readonly id: string
  readonly name: string
  readonly capabilities?: ProviderCapabilities
  readonly fields?: ProviderFieldDefinition[]
  designVoice(request: VoiceDesignRequest, context?: ProviderContext): Promise<VoiceDesignResult>
}

export interface VoiceCloneProvider {
  readonly id: string
  readonly name: string
  readonly capabilities?: ProviderCapabilities
  readonly fields?: ProviderFieldDefinition[]
  cloneVoice(request: VoiceCloneRequest, context?: ProviderContext): Promise<VoiceCloneResult>
}

export interface ProviderRuntimeConfig {
  enabled: boolean
  config: JsonObject
  secrets: JsonObject
}

export interface ProviderConfigInput {
  enabled?: boolean
  config?: JsonObject
  secrets?: JsonObject
}

export interface ProviderConfigRecord extends ProviderRuntimeConfig {
  providerId: string
  createdAt?: string
  updatedAt?: string
}

export interface VoiceRecord {
  id: string
  voiceId: string
  name: string
  description?: string
  language?: string
  previewMimeType?: string
  previewAudio?: string
  metadata: JsonObject
  links: VoiceProviderLinkRecord[]
  createdAt?: string
  updatedAt?: string
}

export interface VoiceProviderLinkRecord {
  id: string
  voiceRecordId: string
  providerId: string
  providerAccountId: string
  providerVoiceId?: string
  providerVoiceKey: string
  previewMimeType?: string
  previewAudio?: string
  metadata: JsonObject
  createdAt?: string
  updatedAt?: string
}

export interface VoiceInput {
  voiceId?: string
  name: string
  description?: string
  language?: string
  previewMimeType?: string
  previewAudio?: string
  metadata?: JsonObject
  providerLink?: VoiceProviderLinkInput
}

export interface VoiceProviderLinkInput {
  providerId: string
  providerAccountId?: string
  providerVoiceId?: string
  providerVoiceKey?: string
  previewMimeType?: string
  previewAudio?: string
  metadata?: JsonObject
}
