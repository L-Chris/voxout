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
  asr?: boolean
  voiceDesign?: boolean
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

export interface TtsSegment {
  id: string
  bookId?: string
  chapterId?: string
  startOffset?: number
  endOffset?: number
  speaker?: string
  text: string
  provider?: string
  soundEffectPrompt?: string
  soundEffectDurationSeconds?: number
  voice?: string
  voiceId?: string
  rate?: string
  pitch?: string
  volume?: string
  emotion?: string
  voicePrompt?: string
  stylePrompt?: string
}

export interface SynthesizeRequest {
  provider?: string
  voice?: string
  voiceId?: string
  lang?: string
  outputFormat?: string
  rate?: string
  pitch?: string
  volume?: string
  voicePrompt?: string
  stylePrompt?: string
  segment: TtsSegment
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
}

export interface TranscribeRequest {
  provider?: string
  url?: string
  bvid?: string
  audioData?: string
  mimeType?: string
  language?: string
  format?: 'txt' | 'srt' | 'raw'
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
  voiceDescription: string
  name?: string
  text?: string
  outputFormat?: string
  model?: string
  autoGenerateText?: boolean
  loudness?: number
  seed?: number
  guidanceScale?: number
  quality?: number
  referenceAudioData?: string
  promptStrength?: number
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
  providerId: string
  voiceId: string
  providerVoiceId?: string
  name: string
  description?: string
  language?: string
  previewMimeType?: string
  previewAudio?: string
  metadata: JsonObject
  createdAt?: string
  updatedAt?: string
}

export interface VoiceInput {
  providerId: string
  voiceId: string
  providerVoiceId?: string
  name: string
  description?: string
  language?: string
  previewMimeType?: string
  previewAudio?: string
  metadata?: JsonObject
}
