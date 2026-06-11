import { randomUUID } from 'node:crypto'
import type { SynthesizeRequest, SynthesizeResult, TtsJob, TtsJobRequest } from './types.js'
import { getProvider } from './providers/registry.js'
import { AudioCache } from './cache.js'
import {
  getSynthesisRateLimitRetryBaseDelayMs,
  getSynthesisRetryBaseDelayMs,
  getSynthesisRetryCount,
  getSynthesisRetryMaxDelayMs,
  getSynthesisTimeoutMs,
  withTimeout,
} from './timeout.js'

export class TaskManager {
  private readonly jobs = new Map<string, TtsJob>()

  constructor(private readonly cache: AudioCache) {}

  createJob(request: TtsJobRequest): TtsJob {
    const now = new Date().toISOString()
    const job: TtsJob = {
      id: randomUUID(),
      status: 'queued',
      provider: request.provider ?? 'mock',
      total: request.segments.length,
      completed: 0,
      failed: 0,
      createdAt: now,
      updatedAt: now,
      results: [],
      failures: [],
    }
    this.jobs.set(job.id, job)
    void this.runJob(job, request)
    return job
  }

  getJob(id: string): TtsJob | null {
    return this.jobs.get(id) ?? null
  }

  getJobResults(id: string): Pick<TtsJob, 'results' | 'failures'> | null {
    const job = this.jobs.get(id)
    return job ? { results: job.results, failures: job.failures } : null
  }

  private async runJob(job: TtsJob, request: TtsJobRequest): Promise<void> {
    job.status = 'running'
    job.updatedAt = new Date().toISOString()
    const concurrency = Math.max(1, Math.min(6, Math.floor(request.concurrency ?? 2)))
    const timeoutMs = getSynthesisTimeoutMs()
    const orderedResults: Array<SynthesizeResult | undefined> = []
    let cursor = 0

    const runNext = async (): Promise<void> => {
      const index = cursor++
      if (index >= request.segments.length) return
      const segment = request.segments[index]
      try {
        const providerId = segment.provider ?? request.provider
        const provider = getProvider(providerId)
        const synthesizeRequest: SynthesizeRequest = {
          provider: providerId,
          voice: request.voice,
          lang: request.lang,
          outputFormat: request.outputFormat,
          rate: request.rate,
          pitch: request.pitch,
          volume: request.volume,
          voicePrompt: request.voicePrompt,
          stylePrompt: request.stylePrompt,
          segment,
        }
        const result = await synthesizeWithRetries(
          synthesizeRequest,
          () => withTimeout(
            this.cache.getOrCreate(synthesizeRequest, () => provider.synthesize(synthesizeRequest)),
            timeoutMs,
            `TTS synthesis timed out after ${timeoutMs}ms for segment ${segment.id}`,
          ),
        )
        orderedResults[index] = result
        job.results = orderedResults.filter((item): item is SynthesizeResult => Boolean(item))
        job.completed++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        job.failed++
        job.error = message
        const failure = {
          index,
          segmentId: segment.id,
          speaker: segment.speaker,
          voice: segment.voice ?? request.voice,
          textPreview: previewText(segment.text),
          error: message,
        }
        job.failures = [...(job.failures ?? []), failure]
        console.error('[rebook-tts] segment failed', JSON.stringify({
          jobId: job.id,
          provider: segment.provider ?? job.provider,
          ...failure,
        }))
      } finally {
        job.updatedAt = new Date().toISOString()
        await runNext()
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, request.segments.length) }, runNext))
    job.status = job.failed === 0 ? 'done' : job.completed > 0 ? 'partial' : 'failed'
    job.updatedAt = new Date().toISOString()
  }
}

async function synthesizeWithRetries(
  request: SynthesizeRequest,
  synthesize: () => Promise<SynthesizeResult>,
): Promise<SynthesizeResult> {
  const retryCount = getSynthesisRetryCount()
  const baseDelayMs = getSynthesisRetryBaseDelayMs()
  const rateLimitBaseDelayMs = getSynthesisRateLimitRetryBaseDelayMs()
  const maxDelayMs = getSynthesisRetryMaxDelayMs()
  let lastError: unknown
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      return await synthesize()
    } catch (error) {
      lastError = error
      if (attempt < retryCount) {
        const delayMs = getRetryDelayMs(error, attempt, {
          baseDelayMs,
          rateLimitBaseDelayMs,
          maxDelayMs,
        })
        console.warn('[rebook-tts] segment retry', JSON.stringify({
          segmentId: request.segment.id,
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        }))
        await delay(delayMs)
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`TTS synthesis failed after ${retryCount + 1} attempt(s) for segment ${request.segment.id}: ${message}`)
}

function getRetryDelayMs(
  error: unknown,
  attempt: number,
  options: {
    baseDelayMs: number
    rateLimitBaseDelayMs: number
    maxDelayMs: number
  },
): number {
  const baseDelayMs = isRateLimitError(error) ? options.rateLimitBaseDelayMs : options.baseDelayMs
  const exponentialDelayMs = baseDelayMs * (2 ** attempt)
  const jitterMs = Math.floor(Math.random() * Math.min(1000, baseDelayMs))
  return Math.min(options.maxDelayMs, exponentialDelayMs + jitterMs)
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /too many requests|rate limit|rate_limit|status\s*429|\b429\b/i.test(message)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized
}
