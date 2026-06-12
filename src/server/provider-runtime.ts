import { ProviderConfigStore } from '../config-store.js'
import {
  getAsrProvider,
  getAudioIsolationProvider,
  getSoundEffectProvider,
  getTtsProvider,
  getVoiceCloneProvider,
  getVoiceDesignProvider,
  isInternalProviderId,
} from '../providers/registry.js'
import type { ProviderRuntimeConfig } from '../types.js'

export const configStore = new ProviderConfigStore()

export function canExposeProvider(providerId: string): boolean {
  return allowInternalProviders() || !isInternalProviderId(providerId)
}

export function assertPublicProviderAccess(providerId: string): void {
  if (!canExposeProvider(providerId)) {
    throw new Error(`Unknown provider: ${providerId}`)
  }
}

export async function getRuntimeConfig(providerId: string): Promise<ProviderRuntimeConfig> {
  return configStore.getConfig(providerId)
}

export function ensureEnabled(providerId: string, context: ProviderRuntimeConfig): void {
  if (!context.enabled) throw new Error(`Provider is disabled: ${providerId}`)
}

export function assertKnownProvider(providerId: string): void {
  try {
    getTtsProvider(providerId)
    return
  } catch {
    try {
      getAsrProvider(providerId)
      return
    } catch {
      try {
        getSoundEffectProvider(providerId)
        return
      } catch {
        try {
          getAudioIsolationProvider(providerId)
          return
        } catch {
          try {
            getVoiceDesignProvider(providerId)
            return
          } catch {
            getVoiceCloneProvider(providerId)
          }
        }
      }
    }
  }
}

function allowInternalProviders(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VOXOUT_EXPOSE_INTERNAL_PROVIDERS === '1'
}
