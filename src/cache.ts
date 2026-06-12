import { createHash } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SynthesizeRequest, SynthesizeResult } from './types.js'

export class AudioCache {
  constructor(
    private readonly audioDir: string,
    private readonly publicBasePath = '/audio',
  ) {}

  async getOrCreate(
    request: SynthesizeRequest,
    create: () => Promise<{ audio: Buffer, mimeType: string, durationMs: number }>,
  ): Promise<SynthesizeResult> {
    await mkdir(this.audioDir, { recursive: true })
    const key = getCacheKey(request)
    const extension = getAudioExtension(request)
    const fileName = `${key}.${extension}`
    const filePath = join(this.audioDir, fileName)
    const existing = await getUsableCachedFile(filePath)
    if (existing) {
      return {
        segmentId: request.segment.id,
        audioUrl: `${this.publicBasePath}/${fileName}`,
        fileName,
        mimeType: getMimeType(extension),
        durationMs: 0,
        cacheHit: true,
      }
    }

    const result = await create()
    if (result.audio.length < 128) {
      throw new Error(`TTS provider returned empty audio for segment ${request.segment.id}`)
    }
    await writeFile(filePath, result.audio)
    return {
      segmentId: request.segment.id,
      audioUrl: `${this.publicBasePath}/${fileName}`,
      fileName,
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      cacheHit: false,
    }
  }
}

function getCacheKey(request: SynthesizeRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: request.segment.provider ?? request.provider ?? 'mock',
      voice: request.segment.voice ?? request.voice ?? '',
      lang: request.lang ?? '',
      outputFormat: request.outputFormat ?? '',
      rate: request.segment.rate ?? request.rate ?? '',
      pitch: request.segment.pitch ?? request.pitch ?? '',
      volume: request.segment.volume ?? request.volume ?? '',
      emotion: request.segment.emotion ?? '',
      voicePrompt: request.segment.voicePrompt ?? request.voicePrompt ?? '',
      stylePrompt: request.segment.stylePrompt ?? request.stylePrompt ?? '',
      soundEffectPrompt: request.segment.soundEffectPrompt ?? '',
      soundEffectDurationSeconds: request.segment.soundEffectDurationSeconds ?? '',
      text: request.segment.text,
    }))
    .digest('hex')
}

function getAudioExtension(request: SynthesizeRequest): 'mp3' | 'wav' {
  const provider = request.segment.provider ?? request.provider ?? 'mock'
  if (provider === 'edge') return 'mp3'
  if (provider === 'elevenlabs') return 'mp3'
  if (provider === 'mimo') {
    const outputFormat = normalizeAudioFormat(request.outputFormat)
    return outputFormat === 'mp3' ? 'mp3' : 'wav'
  }
  if (request.outputFormat?.includes('mp3')) return 'mp3'
  return 'wav'
}

function getMimeType(extension: 'mp3' | 'wav'): string {
  return extension === 'mp3' ? 'audio/mpeg' : 'audio/wav'
}

function normalizeAudioFormat(format: string | undefined): 'mp3' | 'wav' {
  const value = format?.toLowerCase()
  if (value?.includes('mp3')) return 'mp3'
  return 'wav'
}

async function getUsableCachedFile(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path)
    if (!fileStat.isFile()) return false
    if (fileStat.size >= 128) return true
    await rm(path, { force: true })
    return false
  } catch {
    return false
  }
}
