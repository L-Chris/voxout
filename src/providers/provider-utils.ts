import { getProviderTimeoutMs } from '../timeout.js'
import type { ProviderContext } from '../types.js'

export function getConfigString(context: ProviderContext, key: string): string | undefined {
  const value = context.config?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

export function getSecretString(context: ProviderContext, key: string): string | undefined {
  const value = context.secrets?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

export function getConfigNumber(context: ProviderContext, key: string): number | undefined {
  const raw = context.config?.[key]
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export function getPositiveConfigNumber(context: ProviderContext, key: string): number | undefined {
  const value = getConfigNumber(context, key)
  return value != null && value > 0 ? value : undefined
}

export function getConfigBoolean(context: ProviderContext, key: string): boolean | undefined {
  const value = context.config?.[key]
  if (typeof value === 'boolean') return value
  return undefined
}

export function getConfigBooleanWithFallback(context: ProviderContext, key: string, fallback: boolean): boolean {
  return getConfigBoolean(context, key) ?? fallback
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')) as Partial<T>
}

export async function fetchWithProviderTimeout(input: string | URL, init: RequestInit, context: ProviderContext): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), getProviderTimeoutMs(context))
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function readJsonResponse<T>(response: Response, fallback: 'errorString' | 'errorMessageObject' = 'errorString'): Promise<T> {
  const text = await response.text()
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    const error = fallback === 'errorMessageObject'
      ? { message: text.slice(0, 500) }
      : text.slice(0, 500)
    return { error } as T
  }
}

export function getPayloadError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as { error?: unknown, message?: unknown, detail?: unknown }
  if (typeof value.error === 'string') return value.error
  if (value.error && typeof value.error === 'object') {
    const message = (value.error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  if (typeof value.message === 'string') return value.message
  if (typeof value.detail === 'string') return value.detail
  return undefined
}
