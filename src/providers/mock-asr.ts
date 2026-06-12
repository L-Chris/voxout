import type { AsrProvider, TranscribeRequest } from '../types.js'

export class MockAsrProvider implements AsrProvider {
  readonly id = 'mock-asr'
  readonly name = 'Mock ASR Provider'
  readonly capabilities = { asr: true }

  async transcribe(request: TranscribeRequest) {
    const target = request.bvid ? `video ${request.bvid}` : request.url
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text: `Mock transcript for ${target}`,
    }
  }
}
