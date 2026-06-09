import { MockTtsProvider } from './mock.js'
import type { TtsProvider } from '../types.js'

const providers = new Map<string, TtsProvider>()

export function registerProvider(provider: TtsProvider): void {
  providers.set(provider.id, provider)
}

export function getProvider(id = 'mock'): TtsProvider {
  const provider = providers.get(id)
  if (!provider) {
    throw new Error(`Unknown TTS provider: ${id}`)
  }
  return provider
}

export function listProviders(): Array<{ id: string, name: string }> {
  return [...providers.values()].map(provider => ({
    id: provider.id,
    name: provider.name,
  }))
}

registerProvider(new MockTtsProvider())
