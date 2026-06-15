import { getProviderTimeoutMs } from '../timeout.js'
import type { JsonObject, JsonValue, ProviderContext } from '../types.js'

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

export function mergeJsonBody(base: Record<string, unknown>, extra_params?: JsonObject): Record<string, unknown> {
  const compacted = compactObject(base) as Record<string, JsonValue>
  if (!extra_params) return compacted
  return deepMergeJson(extra_params, compacted)
}

export function appendJsonParamsToForm(form: FormData, params?: JsonObject): void {
  if (!params) return
  for (const [key, value] of Object.entries(params)) {
    appendJsonParamToForm(form, key, value)
  }
}

export function getJsonStringParam(params: JsonObject | undefined, key: string): string | undefined {
  const value = params?.[key]
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

export function omitJsonParams(params: JsonObject | undefined, keys: string[]): JsonObject | undefined {
  if (!params) return undefined
  const omitted = new Set(keys)
  const next = Object.fromEntries(Object.entries(params).filter(([key]) => !omitted.has(key))) as JsonObject
  return Object.keys(next).length ? next : undefined
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

function deepMergeJson(base: JsonObject, extra: JsonObject): JsonObject {
  const merged: JsonObject = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const baseValue = merged[key]
    if (isPlainJsonObject(baseValue) && isPlainJsonObject(value)) {
      merged[key] = deepMergeJson(baseValue, value)
    } else {
      merged[key] = value
    }
  }
  return merged
}

function appendJsonParamToForm(form: FormData, key: string, value: JsonValue): void {
  const array_key = key.endsWith('[]') ? key : `${key}[]`
  if (form.has(key) || form.has(array_key)) return
  if (Array.isArray(value)) {
    for (const item of value) form.append(array_key, stringifyFormValue(item))
    return
  }
  form.set(key, stringifyFormValue(value))
}

function stringifyFormValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isPlainJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
