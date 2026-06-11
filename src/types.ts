export type TtsJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'partial'

export interface TtsVoice {
  id: string
  name: string
  locale?: string
  gender?: string
  provider: string
  capabilities?: TtsProviderCapabilities
}

export interface TtsProviderCapabilities {
  voiceDesign?: boolean
  soundEffects?: boolean
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
  lang?: string
  outputFormat?: string
  rate?: string
  pitch?: string
  volume?: string
  voicePrompt?: string
  stylePrompt?: string
  segment: TtsSegment
}

export interface SynthesizeResult {
  segmentId: string
  audioUrl: string
  fileName: string
  mimeType: string
  durationMs: number
  cacheHit: boolean
}

export interface TtsJobRequest {
  provider?: string
  voice?: string
  lang?: string
  outputFormat?: string
  rate?: string
  pitch?: string
  volume?: string
  voicePrompt?: string
  stylePrompt?: string
  concurrency?: number
  segments: TtsSegment[]
}

export interface TtsJob {
  id: string
  status: TtsJobStatus
  provider: string
  total: number
  completed: number
  failed: number
  createdAt: string
  updatedAt: string
  error?: string
  results: SynthesizeResult[]
  failures?: TtsJobFailure[]
}

export interface TtsJobFailure {
  index: number
  segmentId: string
  speaker?: string
  voice?: string
  textPreview: string
  error: string
}

export interface TtsProvider {
  readonly id: string
  readonly name: string
  readonly capabilities?: TtsProviderCapabilities
  listVoices(): Promise<TtsVoice[]>
  synthesize(request: SynthesizeRequest): Promise<{
    audio: Buffer
    mimeType: string
    durationMs: number
  }>
}
