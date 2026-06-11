import { EdgeTtsProvider } from './edge.js'
import { ElevenLabsSoundEffectProvider } from './elevenlabs.js'
import { MimoTtsProvider } from './mimo.js'
import { MockTtsProvider } from './mock.js'
import type { TtsProvider, TtsProviderCapabilities } from '../types.js'

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

export function listProviders(): Array<{ id: string, name: string, capabilities?: TtsProviderCapabilities }> {
  return [...providers.values()].map(provider => ({
    id: provider.id,
    name: provider.name,
    capabilities: provider.capabilities,
  }))
}

registerProvider(new MockTtsProvider())
registerProvider(new EdgeTtsProvider())
registerProvider(new MimoTtsProvider())
registerProvider(new ElevenLabsSoundEffectProvider())
