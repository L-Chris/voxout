import { PrismaClient } from '@prisma/client'
import type {
  JsonObject,
  ProviderConfigInput,
  ProviderConfigRecord,
  ProviderRuntimeConfig,
  VoiceInput,
  VoiceProviderLinkRecord,
  VoiceRecord,
} from './types.js'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
  voices?: VoiceRecord[]
}

export class ProviderConfigStore {
  private readonly prisma: PrismaClient | null

  constructor() {
    this.prisma = process.env.DATABASE_URL
      ? globalForPrisma.prisma ?? new PrismaClient({
        log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
      })
      : null

    if (this.prisma && process.env.NODE_ENV !== 'production') {
      globalForPrisma.prisma = this.prisma
    }
  }

  isDatabaseEnabled(): boolean {
    return Boolean(this.prisma)
  }

  async listConfigs(): Promise<ProviderConfigRecord[]> {
    if (!this.prisma) return []
    const records = await this.prisma.providerConfig.findMany({ orderBy: { provider_id: 'asc' } })
    return records.map(record => ({
      provider_id: record.provider_id,
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: toJsonObject(record.secrets),
      created_at: record.created_at.toISOString(),
      updated_at: record.updated_at.toISOString(),
    }))
  }

  async getConfig(provider_id: string): Promise<ProviderRuntimeConfig> {
    if (!this.prisma) return { enabled: true, config: {}, secrets: {} }
    const record = await this.prisma.providerConfig.findUnique({ where: { provider_id } })
    if (!record) return { enabled: true, config: {}, secrets: {} }
    return {
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: toJsonObject(record.secrets),
    }
  }

  async upsertConfig(provider_id: string, input: ProviderConfigInput): Promise<ProviderConfigRecord> {
    if (!this.prisma) {
      throw new Error('DATABASE_URL is required before provider settings can be persisted.')
    }
    const config = sanitizeObject(input.config)
    const secrets = sanitizeObject(input.secrets)
    const existing = await this.prisma.providerConfig.findUnique({ where: { provider_id } })
    const hasNewSecrets = Object.keys(secrets).length > 0
    const mergedSecrets = hasNewSecrets ? secrets : toJsonObject(existing?.secrets)
    const record = await this.prisma.providerConfig.upsert({
      where: { provider_id },
      create: {
        provider_id,
        enabled: input.enabled ?? true,
        config,
        secrets: mergedSecrets,
      },
      update: {
        enabled: input.enabled ?? true,
        config,
        secrets: mergedSecrets,
      },
    })
    return {
      provider_id: record.provider_id,
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: toJsonObject(record.secrets),
      created_at: record.created_at.toISOString(),
      updated_at: record.updated_at.toISOString(),
    }
  }

  async listVoices(provider_id?: string): Promise<VoiceRecord[]> {
    if (!this.prisma) {
      const voices = globalForPrisma.voices ?? []
      return provider_id ? voices.filter(voice => voice.provider_links.some(link => link.provider_id === provider_id)) : voices
    }
    const records = await this.prisma.voice.findMany({
      where: provider_id ? { provider_links: { some: { provider_id } } } : undefined,
      include: { provider_links: true },
      orderBy: [{ name: 'asc' }],
    })
    return records.map(toVoiceRecord)
  }

  async getVoice(provider_id: string, voice_id: string): Promise<VoiceRecord | null> {
    if (!this.prisma) {
      return (globalForPrisma.voices ?? []).find(voice => (
        voice.voice_id === voice_id
        || voice.provider_links.some(link => link.provider_id === provider_id && (link.provider_voice_id === voice_id || link.provider_voice_key === voice_id))
      )) ?? null
    }
    const record = await this.prisma.voice.findUnique({
      where: { voice_id },
      include: { provider_links: true },
    })
    if (record) return toVoiceRecord(record)
    const link = await this.prisma.voiceProviderLink.findFirst({
      where: {
        provider_id,
        OR: [
          { provider_voice_id: voice_id },
          { provider_voice_key: voice_id },
        ],
      },
      include: { voice: { include: { provider_links: true } } },
    })
    return link ? toVoiceRecord(link.voice) : null
  }

  async upsertVoice(input: VoiceInput): Promise<VoiceRecord> {
    const metadata = sanitizeObject(input.metadata)
    const voice_id = input.voice_id?.trim() || createLocalVoiceId(input.name)
    if (!this.prisma) {
      const voices = globalForPrisma.voices ?? []
      const index = voices.findIndex(voice => voice.voice_id === voice_id)
      const now = new Date().toISOString()
      const existing = index >= 0 ? voices[index] : undefined
      const record: VoiceRecord = {
        id: existing?.id ?? voice_id,
        voice_id,
        name: input.name,
        description: input.description,
        language: input.language,
        preview_mime_type: input.preview_mime_type,
        preview_audio: input.preview_audio,
        metadata,
        provider_links: existing?.provider_links ?? [],
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }
      if (input.provider_link) {
        const link = toMemoryVoiceProviderLink(record.id, input.provider_link, now)
        const linkIndex = record.provider_links.findIndex(item => (
          item.provider_id === link.provider_id
          && item.provider_account_id === link.provider_account_id
        ))
        if (linkIndex >= 0) record.provider_links[linkIndex] = { ...record.provider_links[linkIndex], ...link, updated_at: now }
        else record.provider_links.push(link)
      }
      if (index >= 0) voices[index] = record
      else voices.push(record)
      globalForPrisma.voices = voices
      return record
    }
    const record = await this.prisma.voice.upsert({
      where: { voice_id },
      create: {
        voice_id,
        name: input.name,
        description: input.description,
        language: input.language,
        preview_mime_type: input.preview_mime_type,
        preview_audio: input.preview_audio,
        metadata,
      },
      update: {
        name: input.name,
        description: input.description,
        language: input.language,
        preview_mime_type: input.preview_mime_type,
        preview_audio: input.preview_audio,
        metadata,
      },
      include: { provider_links: true },
    })
    if (!input.provider_link) return toVoiceRecord(record)
    const provider_link = input.provider_link
    const provider_account_id = provider_link.provider_account_id?.trim() || 'default'
    const provider_voice_key = provider_link.provider_voice_key?.trim()
      || provider_link.provider_voice_id?.trim()
      || voice_id
    await this.prisma.voiceProviderLink.upsert({
      where: {
        voice_record_id_provider_id_provider_account_id: {
          voice_record_id: record.id,
          provider_id: provider_link.provider_id,
          provider_account_id,
        },
      },
      create: {
        voice_record_id: record.id,
        provider_id: provider_link.provider_id,
        provider_account_id,
        provider_voice_id: provider_link.provider_voice_id,
        provider_voice_key,
        preview_mime_type: provider_link.preview_mime_type,
        preview_audio: provider_link.preview_audio,
        metadata: sanitizeObject(provider_link.metadata),
      },
      update: {
        provider_voice_id: provider_link.provider_voice_id,
        provider_voice_key,
        preview_mime_type: provider_link.preview_mime_type,
        preview_audio: provider_link.preview_audio,
        metadata: sanitizeObject(provider_link.metadata),
      },
    })
    const updated = await this.prisma.voice.findUniqueOrThrow({
      where: { id: record.id },
      include: { provider_links: true },
    })
    return toVoiceRecord(updated)
  }
}

function sanitizeObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined),
  ) as JsonObject
}

function toJsonObject(value: unknown): JsonObject {
  return sanitizeObject(value)
}

function toVoiceRecord(record: {
  id: string
  voice_id: string
  name: string
  description: string | null
  language: string | null
  preview_mime_type: string | null
  preview_audio: string | null
  metadata: unknown
  provider_links?: Array<{
    id: string
    voice_record_id: string
    provider_id: string
    provider_account_id: string
    provider_voice_id: string | null
    provider_voice_key: string
    preview_mime_type: string | null
    preview_audio: string | null
    metadata: unknown
    created_at: Date
    updated_at: Date
  }>
  created_at: Date
  updated_at: Date
}): VoiceRecord {
  return {
    id: record.id,
    voice_id: record.voice_id,
    name: record.name,
    description: record.description ?? undefined,
    language: record.language ?? undefined,
    preview_mime_type: record.preview_mime_type ?? undefined,
    preview_audio: record.preview_audio ?? undefined,
    metadata: toJsonObject(record.metadata),
    provider_links: (record.provider_links ?? []).map(toVoiceProviderLinkRecord),
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
  }
}

function toVoiceProviderLinkRecord(record: {
  id: string
  voice_record_id: string
  provider_id: string
  provider_account_id: string
  provider_voice_id: string | null
  provider_voice_key: string
  preview_mime_type: string | null
  preview_audio: string | null
  metadata: unknown
  created_at: Date
  updated_at: Date
}): VoiceProviderLinkRecord {
  return {
    id: record.id,
    voice_record_id: record.voice_record_id,
    provider_id: record.provider_id,
    provider_account_id: record.provider_account_id,
    provider_voice_id: record.provider_voice_id ?? undefined,
    provider_voice_key: record.provider_voice_key,
    preview_mime_type: record.preview_mime_type ?? undefined,
    preview_audio: record.preview_audio ?? undefined,
    metadata: toJsonObject(record.metadata),
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
  }
}

function toMemoryVoiceProviderLink(
  voice_record_id: string,
  input: NonNullable<VoiceInput['provider_link']>,
  now: string,
): VoiceProviderLinkRecord {
  const provider_account_id = input.provider_account_id?.trim() || 'default'
  const provider_voice_key = input.provider_voice_key?.trim()
    || input.provider_voice_id?.trim()
    || voice_record_id
  return {
    id: `${voice_record_id}:${input.provider_id}:${provider_account_id}`,
    voice_record_id,
    provider_id: input.provider_id,
    provider_account_id,
    provider_voice_id: input.provider_voice_id,
    provider_voice_key,
    preview_mime_type: input.preview_mime_type,
    preview_audio: input.preview_audio,
    metadata: sanitizeObject(input.metadata),
    created_at: now,
    updated_at: now,
  }
}

function createLocalVoiceId(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `voice_${normalized || Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
}
