import { Service } from 'typedi'
import {
  getTtsProvider,
  isInternalProviderId,
  listAsrProviders,
  listAudioIsolationProviders,
  listProviderDefinitions,
  listSoundEffectProviders,
  listTtsProviders,
  listVoiceCloneProviders,
  listVoiceDesignProviders,
} from '../providers/registry.js'
import {
  assertKnownProvider,
  assertPublicProviderAccess,
  canExposeProvider,
  configStore,
  getRuntimeConfig,
} from './provider-runtime.js'
import { formatVoiceRecord, mergeVoices } from './voice-records.js'
import type {
  ProviderConfigInput,
  ProviderRuntimeConfig,
} from '../types.js'

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
