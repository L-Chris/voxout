export type TtsJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'partial'

export interface TtsVoice {
  id: string
  name: string
  locale?: string
  gender?: string
  provider: string
}

export interface TtsSegment {
  id: string
  bookId?: string
  chapterId?: string
  startOffset?: number
  endOffset?: number
  speaker?: string
  text: string
  voice?: string
  rate?: string
  pitch?: string
  volume?: string
  emotion?: string
}

export interface SynthesizeRequest {
  provider?: string
  voice?: string
  rate?: string
  pitch?: string
  volume?: string
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
  rate?: string
  pitch?: string
  volume?: string
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
}

export interface TtsProvider {
  readonly id: string
  readonly name: string
  listVoices(): Promise<TtsVoice[]>
  synthesize(request: SynthesizeRequest): Promise<{
    audio: Buffer
    mimeType: string
    durationMs: number
  }>
}
