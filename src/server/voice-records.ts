import type { VoiceRecord } from '../types.js'

export function formatVoiceRecord(voice: VoiceRecord) {
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

export function mergeVoices(
  providerVoices: Array<{ id: string, name: string, locale?: string, gender?: string, provider: string }>,
  storedVoices: VoiceRecord[],
) {
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
