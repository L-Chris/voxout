import { EdgeTtsProvider } from './edge.js'
import { ElevenLabsSoundEffectProvider } from './elevenlabs.js'
import { BilibiliAsrProvider } from './bilibili-asr.js'
import { MimoTtsProvider } from './mimo.js'
import { MockAsrProvider } from './mock-asr.js'
import { MockTtsProvider } from './mock.js'
import type { AsrProvider, ProviderDefinition, ProviderRuntimeConfig, TtsProvider } from '../types.js'

const ttsProviders = new Map<string, TtsProvider>()
const asrProviders = new Map<string, AsrProvider>()

export function registerTtsProvider(provider: TtsProvider): void {
  ttsProviders.set(provider.id, provider)
}

export function registerAsrProvider(provider: AsrProvider): void {
  asrProviders.set(provider.id, provider)
}

export function getTtsProvider(id = 'mock'): TtsProvider {
  const provider = ttsProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown TTS provider: ${id}`)
  }
  return provider
}

export function getAsrProvider(id = 'mock-asr'): AsrProvider {
  const provider = asrProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown ASR provider: ${id}`)
  }
  return provider
}

export function getProvider(id: string): TtsProvider | AsrProvider {
  const provider = ttsProviders.get(id) ?? asrProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`)
  }
  return provider
}

export function listTtsProviders(): TtsProvider[] {
  return [...ttsProviders.values()]
}

export function listAsrProviders(): AsrProvider[] {
  return [...asrProviders.values()]
}

export function listProviderDefinitions(configs = new Map<string, ProviderRuntimeConfig>()): ProviderDefinition[] {
  const providers = [...ttsProviders.values(), ...asrProviders.values()]
  return providers.map(provider => {
    const config = configs.get(provider.id) ?? { enabled: true, config: {}, secrets: {} }
    return {
      id: provider.id,
      name: provider.name,
      capabilities: provider.capabilities,
      fields: provider.fields,
      enabled: config.enabled,
      configured: hasConfiguredSecrets(config.secrets),
      config: config.config,
      secrets: maskSecrets(config.secrets),
    }
  })
}

function maskSecrets(secrets: ProviderRuntimeConfig['secrets']): ProviderRuntimeConfig['secrets'] {
  return Object.fromEntries(
    Object.entries(secrets).map(([key, value]) => [key, typeof value === 'string' && value ? '********' : value]),
  )
}

function hasConfiguredSecrets(secrets: ProviderRuntimeConfig['secrets']): boolean {
  return Object.values(secrets).some(value => typeof value === 'string' ? value.length > 0 : value != null)
}

registerTtsProvider(new MockTtsProvider())
registerTtsProvider(new EdgeTtsProvider())
registerTtsProvider(new MimoTtsProvider())
registerTtsProvider(new ElevenLabsSoundEffectProvider())
registerAsrProvider(new MockAsrProvider())
registerAsrProvider(new BilibiliAsrProvider())
