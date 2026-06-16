import type { ProviderContext } from './types.js'

export const DEFAULT_PROVIDER_TIMEOUT_MS = 45000

export function getProviderTimeoutMs(context: ProviderContext = {}): number {
  const raw = context.config?.timeout
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROVIDER_TIMEOUT_MS
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
