import { randomUUID } from 'node:crypto'
import type { SynthesizeRequest, SynthesizeResult, TtsJob, TtsJobRequest } from './types.js'
import { getProvider } from './providers/registry.js'
import { AudioCache } from './cache.js'

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
    }
    this.jobs.set(job.id, job)
    void this.runJob(job, request)
    return job
  }

  getJob(id: string): TtsJob | null {
    return this.jobs.get(id) ?? null
  }

  getJobResults(id: string): SynthesizeResult[] | null {
    return this.jobs.get(id)?.results ?? null
  }

  private async runJob(job: TtsJob, request: TtsJobRequest): Promise<void> {
    job.status = 'running'
    job.updatedAt = new Date().toISOString()
    const provider = getProvider(request.provider)
    const concurrency = Math.max(1, Math.min(6, Math.floor(request.concurrency ?? 2)))
    let cursor = 0

    const runNext = async (): Promise<void> => {
      const index = cursor++
      if (index >= request.segments.length) return
      const segment = request.segments[index]
      try {
        const synthesizeRequest: SynthesizeRequest = {
          provider: request.provider,
          voice: request.voice,
          rate: request.rate,
          pitch: request.pitch,
          volume: request.volume,
          segment,
        }
        const result = await this.cache.getOrCreate(synthesizeRequest, () => provider.synthesize(synthesizeRequest))
        job.results.push(result)
        job.completed++
      } catch (error) {
        job.failed++
        job.error = error instanceof Error ? error.message : String(error)
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
