import { PrismaClient } from '@prisma/client'
import type { JsonObject, ProviderConfigInput, ProviderConfigRecord, ProviderRuntimeConfig } from './types.js'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
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
    const records = await this.prisma.providerConfig.findMany({ orderBy: { providerId: 'asc' } })
    return records.map(record => ({
      providerId: record.providerId,
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: toJsonObject(record.secrets),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }))
  }

  async getConfig(providerId: string): Promise<ProviderRuntimeConfig> {
    if (!this.prisma) return { enabled: true, config: {}, secrets: {} }
    const record = await this.prisma.providerConfig.findUnique({ where: { providerId } })
    if (!record) return { enabled: true, config: {}, secrets: {} }
    return {
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: toJsonObject(record.secrets),
    }
  }

  async upsertConfig(providerId: string, input: ProviderConfigInput): Promise<ProviderConfigRecord> {
    if (!this.prisma) {
      throw new Error('DATABASE_URL is required before provider settings can be persisted.')
    }
    const config = sanitizeObject(input.config)
    const secrets = sanitizeObject(input.secrets)
    const existing = await this.prisma.providerConfig.findUnique({ where: { providerId } })
    const hasNewSecrets = Object.keys(secrets).length > 0
    const mergedSecrets = hasNewSecrets ? secrets : toJsonObject(existing?.secrets)
    const record = await this.prisma.providerConfig.upsert({
      where: { providerId },
      create: {
        providerId,
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
      providerId: record.providerId,
      enabled: record.enabled,
      config: toJsonObject(record.config),
      secrets: toJsonObject(record.secrets),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }
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
