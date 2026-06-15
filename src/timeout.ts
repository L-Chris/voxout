import type { ProviderContext } from './types.js'

export const DEFAULT_PROVIDER_TIMEOUT_MS = 45000

export function getProviderTimeoutMs(context: ProviderContext = {}): number {
  const raw = context.config?.timeout_ms
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROVIDER_TIMEOUT_MS
}

export function withTimeout<T>(promise: Promise<T>, timeout_ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout_ms)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
