import { Service } from 'typedi'
import { ProviderConfigStore } from '../config-store.js'
import {
  getAsrProvider,
  getAudioIsolationProvider,
  getSoundEffectProvider,
  getTtsProvider,
  getVoiceCloneProvider,
  getVoiceDesignProvider,
  isInternalProviderId,
  listAsrProviders,
  listAudioIsolationProviders,
  listProviderDefinitions,
  listSoundEffectProviders,
  listTtsProviders,
  listVoiceCloneProviders,
  listVoiceDesignProviders,
} from '../providers/registry.js'
import type {
  ProviderConfigInput,
  ProviderRuntimeConfig,
  VoiceRecord,
} from '../types.js'

const configStore = new ProviderConfigStore()

@Service()
export class ProviderService {
  health(): { ok: true, database: 'enabled' | 'disabled' } {
    return { ok: true, database: configStore.isDatabaseEnabled() ? 'enabled' : 'disabled' }
  }

  async listProviders() {
    const configMap = await getConfigMap()
    return { providers: listProviderDefinitions(configMap), database: configStore.isDatabaseEnabled() }
  }

  async listVoices(provider_id?: string) {
    if (provider_id) assertPublicProviderAccess(provider_id)
    const voices = (await configStore.listVoices(provider_id))
      .filter(voice => voice.provider_links.some(link => canExposeProvider(link.provider_id)))
    return { voices: voices.map(formatVoiceRecord) }
  }

  async listProviderVoices(provider_id: string) {
    assertPublicProviderAccess(provider_id)
    const provider = getTtsProvider(provider_id)
    const context = await getRuntimeConfig(provider.id)
    const voices = mergeVoices(await provider.listVoices(context), await configStore.listVoices(provider.id))
    return { voices }
  }

  listModels() {
    return { object: 'list' as const, data: listOpenAiModels() }
  }

  async updateProviderConfig(provider_id: string, input: ProviderConfigInput) {
    assertKnownProvider(provider_id)
    assertPublicProviderAccess(provider_id)
    const record = await configStore.upsertConfig(provider_id, input)
    return { provider: record }
  }
}

async function getConfigMap(): Promise<Map<string, ProviderRuntimeConfig>> {
  const records = await configStore.listConfigs()
  return new Map(records.map(record => [record.provider_id, record]))
}

async function getRuntimeConfig(provider_id: string): Promise<ProviderRuntimeConfig> {
  return configStore.getConfig(provider_id)
}

function listOpenAiModels(): Array<{
  id: string
  object: 'model'
  created: number
  owned_by: string
  capabilities: Record<string, boolean>
}> {
  const models = new Map<string, {
    id: string
    object: 'model'
    created: number
    owned_by: string
    capabilities: Record<string, boolean>
  }>()
  for (const provider of [
    ...listTtsProviders(),
    ...listAsrProviders(),
    ...listSoundEffectProviders(),
    ...listAudioIsolationProviders(),
    ...listVoiceDesignProviders(),
    ...listVoiceCloneProviders(),
  ].filter(provider => !isInternalProviderId(provider.id))) {
    const existing = models.get(provider.id)
    models.set(provider.id, {
      id: provider.id,
      object: 'model',
      created: 0,
      owned_by: 'voxout',
      capabilities: {
        ...(existing?.capabilities ?? {}),
        ...(provider.capabilities ?? {}),
      },
    })
  }
  return [...models.values()]
}

function canExposeProvider(provider_id: string): boolean {
  return allowInternalProviders() || !isInternalProviderId(provider_id)
}

function assertPublicProviderAccess(provider_id: string): void {
  if (!canExposeProvider(provider_id)) {
    throw new Error(`Unknown provider: ${provider_id}`)
  }
}

function allowInternalProviders(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VOXOUT_EXPOSE_INTERNAL_PROVIDERS === '1'
}

function assertKnownProvider(provider_id: string): void {
  try {
    getTtsProvider(provider_id)
    return
  } catch {
    try {
      getAsrProvider(provider_id)
      return
    } catch {
      try {
        getSoundEffectProvider(provider_id)
        return
      } catch {
        try {
          getAudioIsolationProvider(provider_id)
          return
        } catch {
          try {
            getVoiceDesignProvider(provider_id)
            return
          } catch {
            getVoiceCloneProvider(provider_id)
          }
        }
      }
    }
  }
}

function mergeVoices(providerVoices: Array<{ id: string, name: string, locale?: string, gender?: string, provider: string }>, storedVoices: VoiceRecord[]) {
  const byId = new Map(providerVoices.map(voice => [voice.id, voice]))
  for (const voice of storedVoices) {
    const link = voice.provider_links.find(item => item.provider_id === providerVoices[0]?.provider) ?? voice.provider_links[0]
    const id = link?.provider_voice_id ?? link?.provider_voice_key ?? voice.voice_id
    byId.set(id, {
      id,
      name: voice.name,
      locale: voice.language,
      provider: link?.provider_id ?? 'voxout',
    })
  }
  return [...byId.values()]
}

function formatVoiceRecord(voice: VoiceRecord) {
  return {
    id: voice.id,
    voice_id: voice.voice_id,
    name: voice.name,
    description: voice.description,
    language: voice.language,
    preview_mime_type: voice.preview_mime_type,
    preview_audio: voice.preview_audio,
    metadata: voice.metadata,
    provider_links: voice.provider_links.map(link => ({
      id: link.id,
      provider: link.provider_id,
      provider_account_id: link.provider_account_id,
      provider_voice_id: link.provider_voice_id,
      provider_voice_key: link.provider_voice_key,
      preview_mime_type: link.preview_mime_type,
      preview_audio: link.preview_audio,
      metadata: link.metadata,
      created_at: link.created_at,
      updated_at: link.updated_at,
    })),
    created_at: voice.created_at,
    updated_at: voice.updated_at,
  }
}
