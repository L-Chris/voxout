import { EdgeTtsProvider } from './edge.js'
import { ElevenLabsProvider } from './elevenlabs.js'
import { BilibiliAsrProvider } from './bilibili-asr.js'
import { MimoTtsProvider } from './mimo.js'
import { MockAsrProvider } from './mock-asr.js'
import { MockTtsProvider } from './mock.js'
import type {
  AsrProvider,
  AudioIsolationProvider,
  ProviderDefinition,
  ProviderFieldDefinition,
  ProviderRuntimeConfig,
  SoundEffectProvider,
  TtsProvider,
  VoiceDesignProvider,
} from '../types.js'

const COMMON_PROVIDER_FIELDS: ProviderFieldDefinition[] = [
  { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', placeholder: '45000' },
]
const INTERNAL_PROVIDER_IDS = new Set(['mock', 'mock-asr'])

const ttsProviders = new Map<string, TtsProvider>()
const asrProviders = new Map<string, AsrProvider>()
const soundEffectProviders = new Map<string, SoundEffectProvider>()
const audioIsolationProviders = new Map<string, AudioIsolationProvider>()
const voiceDesignProviders = new Map<string, VoiceDesignProvider>()

export function registerTtsProvider(provider: TtsProvider): void {
  ttsProviders.set(provider.id, provider)
}

export function registerAsrProvider(provider: AsrProvider): void {
  asrProviders.set(provider.id, provider)
}

export function registerSoundEffectProvider(provider: SoundEffectProvider): void {
  soundEffectProviders.set(provider.id, provider)
}

export function registerAudioIsolationProvider(provider: AudioIsolationProvider): void {
  audioIsolationProviders.set(provider.id, provider)
}

export function registerVoiceDesignProvider(provider: VoiceDesignProvider): void {
  voiceDesignProviders.set(provider.id, provider)
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

export function getSoundEffectProvider(id = 'mock'): SoundEffectProvider {
  const provider = soundEffectProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown sound effect provider: ${id}`)
  }
  return provider
}

export function getAudioIsolationProvider(id: string): AudioIsolationProvider {
  const provider = audioIsolationProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown audio isolation provider: ${id}`)
  }
  return provider
}

export function getVoiceDesignProvider(id: string): VoiceDesignProvider {
  const provider = voiceDesignProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown voice design provider: ${id}`)
  }
  return provider
}

export function getProvider(id: string): TtsProvider | AsrProvider | SoundEffectProvider | AudioIsolationProvider | VoiceDesignProvider {
  const provider = ttsProviders.get(id)
    ?? asrProviders.get(id)
    ?? soundEffectProviders.get(id)
    ?? audioIsolationProviders.get(id)
    ?? voiceDesignProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`)
  }
  return provider
}

export function isInternalProviderId(id: string): boolean {
  return INTERNAL_PROVIDER_IDS.has(id)
}

export function listTtsProviders(): TtsProvider[] {
  return [...ttsProviders.values()]
}

export function listAsrProviders(): AsrProvider[] {
  return [...asrProviders.values()]
}

export function listSoundEffectProviders(): SoundEffectProvider[] {
  return [...soundEffectProviders.values()]
}

export function listAudioIsolationProviders(): AudioIsolationProvider[] {
  return [...audioIsolationProviders.values()]
}

export function listVoiceDesignProviders(): VoiceDesignProvider[] {
  return [...voiceDesignProviders.values()]
}

export function listProviderDefinitions(
  configs = new Map<string, ProviderRuntimeConfig>(),
  options: { includeInternal?: boolean } = {},
): ProviderDefinition[] {
  const providers = [...new Map(
    [
      ...ttsProviders.values(),
      ...asrProviders.values(),
      ...soundEffectProviders.values(),
      ...audioIsolationProviders.values(),
      ...voiceDesignProviders.values(),
    ].map(provider => [provider.id, provider]),
  ).values()].filter(provider => options.includeInternal || !INTERNAL_PROVIDER_IDS.has(provider.id))
  return providers.map(provider => {
    const config = configs.get(provider.id) ?? { enabled: true, config: {}, secrets: {} }
    return {
      id: provider.id,
      name: provider.name,
      capabilities: provider.capabilities,
      fields: mergeProviderFields(provider.fields),
      enabled: config.enabled,
      configured: hasConfiguredSecrets(config.secrets),
      config: config.config,
      secrets: maskSecrets(config.secrets),
    }
  })
}

function mergeProviderFields(fields: readonly ProviderFieldDefinition[] | undefined): ProviderFieldDefinition[] {
  const merged = [...(fields ?? [])]
  const keys = new Set(merged.map(field => field.key))
  for (const field of COMMON_PROVIDER_FIELDS) {
    if (!keys.has(field.key)) merged.push(field)
  }
  return merged
}

function maskSecrets(secrets: ProviderRuntimeConfig['secrets']): ProviderRuntimeConfig['secrets'] {
  return Object.fromEntries(
    Object.entries(secrets).map(([key, value]) => [key, typeof value === 'string' && value ? '********' : value]),
  )
}

function hasConfiguredSecrets(secrets: ProviderRuntimeConfig['secrets']): boolean {
  return Object.values(secrets).some(value => typeof value === 'string' ? value.length > 0 : value != null)
}

const mockProvider = new MockTtsProvider()
registerTtsProvider(mockProvider)
registerSoundEffectProvider(mockProvider)
registerAudioIsolationProvider(mockProvider)
registerVoiceDesignProvider(mockProvider)
registerTtsProvider(new EdgeTtsProvider())
const mimoProvider = new MimoTtsProvider()
registerTtsProvider(mimoProvider)
const elevenLabsProvider = new ElevenLabsProvider()
registerTtsProvider(elevenLabsProvider)
registerAsrProvider(elevenLabsProvider)
registerSoundEffectProvider(elevenLabsProvider)
registerAudioIsolationProvider(elevenLabsProvider)
registerVoiceDesignProvider(elevenLabsProvider)
registerAsrProvider(new MockAsrProvider())
registerAsrProvider(mimoProvider)
registerVoiceDesignProvider(mimoProvider)
registerAsrProvider(new BilibiliAsrProvider())
