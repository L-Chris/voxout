import type { ProviderContext } from './types.js'

export const DEFAULT_PROVIDER_TIMEOUT_MS = 45000
export const DEFAULT_PROVIDER_RETRY_COUNT = 2
export const MAX_PROVIDER_RETRY_COUNT = 5

export function getProviderTimeoutMs(context: ProviderContext = {}): number {
  const raw = context.config?.timeout
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROVIDER_TIMEOUT_MS
}

export function getProviderRetryCount(context: ProviderContext = {}): number {
  if (context.config?.auto_retry !== true) return 0
  const raw = context.config?.retry_count
  if (raw == null || raw === '') return DEFAULT_PROVIDER_RETRY_COUNT
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_PROVIDER_RETRY_COUNT, Math.floor(value))
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
