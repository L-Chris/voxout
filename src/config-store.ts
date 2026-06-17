import { PrismaClient } from '@prisma/client'
import type {
  JsonObject,
  ProviderApiKeyInput,
  ProviderApiKeyRecord,
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
  providerApiKeys?: ProviderApiKeyMemoryRecord[]
}

interface ProviderApiKeyMemoryRecord {
  id: string
  provider_id: string
  name: string
  api_key: string
  weight: number
  enabled: boolean
  metadata: JsonObject
  created_at: string
  updated_at: string
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
    await Promise.all(records.map(record => this.migrateLegacyApiKey(record.provider_id)))
    const apiKeyCounts = await this.getApiKeyCounts(records.map(record => record.provider_id))
    return Promise.all(records.map(async record => ({
      provider_id: record.provider_id,
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: withSelectedApiKey(stripApiKey(toJsonObject(record.secrets)), await this.selectApiKey(record.provider_id)),
      api_key_count: apiKeyCounts.get(record.provider_id) ?? 0,
      created_at: record.created_at.toISOString(),
      updated_at: record.updated_at.toISOString(),
    })))
  }

  async getConfig(provider_id: string): Promise<ProviderRuntimeConfig> {
    if (!this.prisma) {
      return { enabled: true, config: {}, secrets: withSelectedApiKey({}, await this.selectApiKey(provider_id)) }
    }
    await this.migrateLegacyApiKey(provider_id)
    const record = await this.prisma.providerConfig.findUnique({ where: { provider_id } })
    if (!record) return { enabled: true, config: {}, secrets: {} }
    return {
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: withSelectedApiKey(stripApiKey(toJsonObject(record.secrets)), await this.selectApiKey(provider_id)),
    }
  }

  async upsertConfig(provider_id: string, input: ProviderConfigInput): Promise<ProviderConfigRecord> {
    if (!this.prisma) {
      throw new Error('DATABASE_URL is required before provider settings can be persisted.')
    }
    await this.migrateLegacyApiKey(provider_id)
    const config = sanitizeObject(input.config)
    const secrets = stripApiKey(sanitizeObject(input.secrets))
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
      api_key_count: await this.countApiKeys(provider_id),
      created_at: record.created_at.toISOString(),
      updated_at: record.updated_at.toISOString(),
    }
  }

  async listApiKeys(provider_id: string): Promise<ProviderApiKeyRecord[]> {
    if (!this.prisma) {
      return (globalForPrisma.providerApiKeys ?? [])
        .filter(record => record.provider_id === provider_id)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(toProviderApiKeyRecord)
    }
    await this.migrateLegacyApiKey(provider_id)
    const records = await this.prisma.providerApiKey.findMany({
      where: { provider_id },
      orderBy: [{ name: 'asc' }, { created_at: 'asc' }],
    })
    return records.map(toProviderApiKeyRecord)
  }

  async createApiKey(provider_id: string, input: ProviderApiKeyInput): Promise<ProviderApiKeyRecord> {
    const api_key = normalizeApiKey(input.api_key)
    if (!api_key) throw new Error('api_key is required.')
    const name = normalizeApiKeyName(input.name)
    const weight = normalizeApiKeyWeight(input.weight)
    const enabled = input.enabled ?? true
    const metadata = sanitizeObject(input.metadata)

    if (!this.prisma) {
      const records = globalForPrisma.providerApiKeys ?? []
      const now = new Date().toISOString()
      const record: ProviderApiKeyMemoryRecord = {
        id: `key_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
        provider_id,
        name,
        api_key,
        weight,
        enabled,
        metadata,
        created_at: now,
        updated_at: now,
      }
      records.push(record)
      globalForPrisma.providerApiKeys = records
      return toProviderApiKeyRecord(record)
    }

    await this.migrateLegacyApiKey(provider_id)
    const record = await this.prisma.providerApiKey.create({
      data: { provider_id, name, api_key, weight, enabled, metadata },
    })
    return toProviderApiKeyRecord(record)
  }

  async updateApiKey(provider_id: string, api_key_id: string, input: ProviderApiKeyInput): Promise<ProviderApiKeyRecord> {
    if (!this.prisma) {
      const records = globalForPrisma.providerApiKeys ?? []
      const index = records.findIndex(record => record.provider_id === provider_id && record.id === api_key_id)
      if (index < 0) throw new Error('API key not found.')
      const existing = records[index]
      const nextApiKey = input.api_key === undefined ? existing.api_key : normalizeApiKey(input.api_key)
      if (!nextApiKey) throw new Error('api_key cannot be empty.')
      const updated: ProviderApiKeyMemoryRecord = {
        ...existing,
        name: input.name === undefined ? existing.name : normalizeApiKeyName(input.name),
        api_key: nextApiKey,
        weight: input.weight === undefined ? existing.weight : normalizeApiKeyWeight(input.weight),
        enabled: input.enabled ?? existing.enabled,
        metadata: input.metadata === undefined ? existing.metadata : sanitizeObject(input.metadata),
        updated_at: new Date().toISOString(),
      }
      records[index] = updated
      return toProviderApiKeyRecord(updated)
    }

    await this.migrateLegacyApiKey(provider_id)
    const existing = await this.prisma.providerApiKey.findFirst({ where: { id: api_key_id, provider_id } })
    if (!existing) throw new Error('API key not found.')
    const data: {
      name?: string
      api_key?: string
      weight?: number
      enabled?: boolean
      metadata?: JsonObject
    } = {}
    if (input.name !== undefined) data.name = normalizeApiKeyName(input.name)
    if (input.api_key !== undefined) {
      const api_key = normalizeApiKey(input.api_key)
      if (!api_key) throw new Error('api_key cannot be empty.')
      data.api_key = api_key
    }
    if (input.enabled !== undefined) data.enabled = input.enabled
    if (input.weight !== undefined) data.weight = normalizeApiKeyWeight(input.weight)
    if (input.metadata !== undefined) data.metadata = sanitizeObject(input.metadata)
    const record = await this.prisma.providerApiKey.update({
      where: { id: api_key_id },
      data,
    })
    return toProviderApiKeyRecord(record)
  }

  async deleteApiKey(provider_id: string, api_key_id: string): Promise<void> {
    if (!this.prisma) {
      globalForPrisma.providerApiKeys = (globalForPrisma.providerApiKeys ?? [])
        .filter(record => !(record.provider_id === provider_id && record.id === api_key_id))
      return
    }
    await this.migrateLegacyApiKey(provider_id)
    const existing = await this.prisma.providerApiKey.findFirst({ where: { id: api_key_id, provider_id } })
    if (!existing) throw new Error('API key not found.')
    await this.prisma.providerApiKey.delete({ where: { id: api_key_id } })
  }

  private async selectApiKey(provider_id: string): Promise<string | undefined> {
    if (!this.prisma) {
      return selectWeightedApiKey((globalForPrisma.providerApiKeys ?? [])
        .filter(record => record.provider_id === provider_id && record.enabled && record.weight > 0))
    }
    const records = await this.prisma.providerApiKey.findMany({
      where: { provider_id, enabled: true, weight: { gt: 0 } },
      orderBy: [{ name: 'asc' }, { created_at: 'asc' }],
    })
    return selectWeightedApiKey(records)
  }

  private async countApiKeys(provider_id: string): Promise<number> {
    if (!this.prisma) {
      return (globalForPrisma.providerApiKeys ?? [])
        .filter(record => record.provider_id === provider_id)
        .length
    }
    return this.prisma.providerApiKey.count({ where: { provider_id } })
  }

  private async getApiKeyCounts(provider_ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    if (!this.prisma || !provider_ids.length) return counts
    const grouped = await this.prisma.providerApiKey.groupBy({
      by: ['provider_id'],
      where: { provider_id: { in: provider_ids } },
      _count: { _all: true },
    })
    for (const item of grouped) counts.set(item.provider_id, item._count._all)
    return counts
  }

  private async migrateLegacyApiKey(provider_id: string): Promise<void> {
    if (!this.prisma) return
    const config = await this.prisma.providerConfig.findUnique({ where: { provider_id } })
    const secrets = toJsonObject(config?.secrets)
    const legacyApiKey = normalizeApiKey(secrets.api_key)
    if (!legacyApiKey) return

    const existingCount = await this.prisma.providerApiKey.count({ where: { provider_id } })
    if (existingCount === 0) {
      await this.prisma.providerApiKey.create({
        data: {
          provider_id,
          name: 'Default',
          api_key: legacyApiKey,
          weight: 1,
          enabled: true,
          metadata: {},
        },
      })
    }

    const { api_key: _legacyApiKey, ...restSecrets } = secrets
    await this.prisma.providerConfig.update({
      where: { provider_id },
      data: { secrets: restSecrets },
    })
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

function withSelectedApiKey(secrets: JsonObject, api_key: string | undefined): JsonObject {
  return api_key ? { ...secrets, api_key } : secrets
}

function stripApiKey(secrets: JsonObject): JsonObject {
  const { api_key: _apiKey, ...rest } = secrets
  return rest
}

function normalizeApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeApiKeyName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  return name || 'Default'
}

function normalizeApiKeyWeight(value: unknown): number {
  const weight = Number(value ?? 1)
  if (!Number.isFinite(weight)) return 1
  return Math.max(0, Math.floor(weight))
}

function selectWeightedApiKey(records: Array<{ api_key: string, weight: number }>): string | undefined {
  const candidates = records.filter(record => record.weight > 0)
  const totalWeight = candidates.reduce((total, record) => total + record.weight, 0)
  if (totalWeight <= 0) return undefined
  let cursor = Math.random() * totalWeight
  for (const record of candidates) {
    cursor -= record.weight
    if (cursor < 0) return record.api_key
  }
  return candidates.at(-1)?.api_key
}

function toProviderApiKeyRecord(record: {
  id: string
  provider_id: string
  name: string
  api_key: string
  weight: number
  enabled: boolean
  metadata: unknown
  created_at: Date | string
  updated_at: Date | string
}): ProviderApiKeyRecord {
  return {
    id: record.id,
    provider_id: record.provider_id,
    name: record.name,
    key_hint: maskApiKey(record.api_key),
    weight: record.weight,
    enabled: record.enabled,
    metadata: toJsonObject(record.metadata),
    created_at: toIsoString(record.created_at),
    updated_at: toIsoString(record.updated_at),
  }
}

function maskApiKey(api_key: string): string {
  if (!api_key) return ''
  if (api_key.length <= 8) return '********'
  return `${api_key.slice(0, 4)}...${api_key.slice(-4)}`
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
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
