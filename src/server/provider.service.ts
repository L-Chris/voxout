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
  ProviderApiKeyInput,
  ProviderRuntimeConfig,
  ProviderCapabilities,
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

  async listProviderApiKeys(provider_id: string) {
    assertKnownProvider(provider_id)
    assertPublicProviderAccess(provider_id)
    return { api_keys: await configStore.listApiKeys(provider_id) }
  }

  async createProviderApiKey(provider_id: string, input: ProviderApiKeyInput) {
    assertKnownProvider(provider_id)
    assertPublicProviderAccess(provider_id)
    return { api_key: await configStore.createApiKey(provider_id, input) }
  }

  async updateProviderApiKey(provider_id: string, api_key_id: string, input: ProviderApiKeyInput) {
    assertKnownProvider(provider_id)
    assertPublicProviderAccess(provider_id)
    return { api_key: await configStore.updateApiKey(provider_id, api_key_id, input) }
  }

  async deleteProviderApiKey(provider_id: string, api_key_id: string) {
    assertKnownProvider(provider_id)
    assertPublicProviderAccess(provider_id)
    await configStore.deleteApiKey(provider_id, api_key_id)
    return { deleted: true }
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
  providers?: string[]
}> {
  const models = new Map<string, {
    id: string
    object: 'model'
    created: number
    owned_by: string
    capabilities: Record<string, boolean>
    providers?: string[]
  }>()
  const providers = [
    ...listTtsProviders(),
    ...listAsrProviders(),
    ...listSoundEffectProviders(),
    ...listAudioIsolationProviders(),
    ...listVoiceDesignProviders(),
    ...listVoiceCloneProviders(),
  ].filter(provider => !isInternalProviderId(provider.id))
  const uniqueProviders = [...new Map(providers.map(provider => [provider.id, provider])).values()]
  const providerIds = new Set(uniqueProviders.map(provider => provider.id))

  for (const provider of uniqueProviders) {
    mergeModel(models, {
      id: provider.id,
      owned_by: 'voxout',
      capabilities: provider.capabilities ?? {},
      providers: [provider.id],
    })
    for (const field of provider.fields ?? []) {
      const capability = getModelFieldCapability(field.key)
      if (!capability) continue
      for (const model of field.options ?? []) {
        if (providerIds.has(model)) continue
        mergeModel(models, {
          id: model,
          owned_by: provider.id,
          capabilities: { [capability]: true },
          providers: [provider.id],
        })
      }
    }
  }
  return [...models.values()]
}

function mergeModel(
  models: Map<string, {
    id: string
    object: 'model'
    created: number
    owned_by: string
    capabilities: Record<string, boolean>
    providers?: string[]
  }>,
  model: {
    id: string
    owned_by: string
    capabilities: ProviderCapabilities
    providers?: string[]
  },
): void {
  const existing = models.get(model.id)
  models.set(model.id, {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: existing?.owned_by ?? model.owned_by,
    capabilities: {
      ...(existing?.capabilities ?? {}),
      ...model.capabilities,
    },
    providers: uniqueStrings([...(existing?.providers ?? []), ...(model.providers ?? [])]),
  })
}

function getModelFieldCapability(fieldKey: string): keyof ProviderCapabilities | undefined {
  if (fieldKey === 'tts_model') return 'tts'
  if (fieldKey === 'asr_model') return 'asr'
  if (fieldKey === 'sound_effect_model') return 'sound_effects'
  if (fieldKey === 'voice_design_model') return 'voice_design'
  return undefined
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean)
}
