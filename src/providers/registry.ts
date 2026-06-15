import { CartesiaProvider } from './cartesia.js'
import { ElevenLabsProvider } from './elevenlabs.js'
import { DefaultProvider } from './default/index.js'
import { GradiumProvider } from './gradium.js'
import { MimoTtsProvider } from './mimo.js'
import { MockAsrProvider, MockTtsProvider } from './mock.js'
import { OpenAiProvider } from './openai.js'
import type {
  AsrProvider,
  AudioIsolationProvider,
  ProviderDefinition,
  ProviderFieldDefinition,
  ProviderRuntimeConfig,
  SoundEffectProvider,
  TtsProvider,
  VoiceCloneProvider,
  VoiceDesignProvider,
} from '../types.js'

const COMMON_PROVIDER_FIELDS: ProviderFieldDefinition[] = [
  { key: 'account_id', label: 'Provider Account ID', type: 'text', placeholder: 'default' },
  { key: 'timeout_ms', label: 'Timeout (ms)', type: 'number', placeholder: '45000' },
]
const INTERNAL_PROVIDER_IDS = new Set(['mock', 'mock-asr'])

const ttsProviders = new Map<string, TtsProvider>()
const asrProviders = new Map<string, AsrProvider>()
const soundEffectProviders = new Map<string, SoundEffectProvider>()
const audioIsolationProviders = new Map<string, AudioIsolationProvider>()
const voiceDesignProviders = new Map<string, VoiceDesignProvider>()
const voiceCloneProviders = new Map<string, VoiceCloneProvider>()

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

export function registerVoiceCloneProvider(provider: VoiceCloneProvider): void {
  voiceCloneProviders.set(provider.id, provider)
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

export function getVoiceCloneProvider(id: string): VoiceCloneProvider {
  const provider = voiceCloneProviders.get(id)
  if (!provider) {
    throw new Error(`Unknown voice clone provider: ${id}`)
  }
  return provider
}

export function getProvider(id: string): TtsProvider | AsrProvider | SoundEffectProvider | AudioIsolationProvider | VoiceDesignProvider | VoiceCloneProvider {
  const provider = ttsProviders.get(id)
    ?? asrProviders.get(id)
    ?? soundEffectProviders.get(id)
    ?? audioIsolationProviders.get(id)
    ?? voiceDesignProviders.get(id)
    ?? voiceCloneProviders.get(id)
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

export function listVoiceCloneProviders(): VoiceCloneProvider[] {
  return [...voiceCloneProviders.values()]
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
      ...voiceCloneProviders.values(),
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
registerVoiceCloneProvider(mockProvider)
const openAiProvider = new OpenAiProvider()
registerTtsProvider(openAiProvider)
registerAsrProvider(openAiProvider)
registerVoiceCloneProvider(openAiProvider)
const cartesiaProvider = new CartesiaProvider()
registerTtsProvider(cartesiaProvider)
registerAsrProvider(cartesiaProvider)
registerVoiceCloneProvider(cartesiaProvider)
const defaultProvider = new DefaultProvider()
registerTtsProvider(defaultProvider)
registerAsrProvider(defaultProvider)
const gradiumProvider = new GradiumProvider()
registerTtsProvider(gradiumProvider)
registerAsrProvider(gradiumProvider)
registerVoiceCloneProvider(gradiumProvider)
const mimoProvider = new MimoTtsProvider()
registerTtsProvider(mimoProvider)
registerVoiceCloneProvider(mimoProvider)
const elevenLabsProvider = new ElevenLabsProvider()
registerTtsProvider(elevenLabsProvider)
registerAsrProvider(elevenLabsProvider)
registerSoundEffectProvider(elevenLabsProvider)
registerAudioIsolationProvider(elevenLabsProvider)
registerVoiceDesignProvider(elevenLabsProvider)
registerVoiceCloneProvider(elevenLabsProvider)
registerAsrProvider(new MockAsrProvider())
registerAsrProvider(mimoProvider)
registerVoiceDesignProvider(mimoProvider)
