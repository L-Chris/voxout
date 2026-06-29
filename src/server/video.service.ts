import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service } from 'typedi'
import {
  getVideoProvider,
  listVideoProviders,
} from '../providers/registry.js'
import { getProviderTimeoutMs, withTimeout } from '../timeout.js'
import { readJson, readMultipartForm, sendBinary, sendJson, sendStream } from './http.js'
import {
  assertPublicProviderAccess,
  ensureEnabled,
  getRuntimeConfig,
} from './provider-runtime.js'
import type {
  JsonObject,
  JsonValue,
  ProviderFile,
  VideoCreateRequest,
} from '../types.js'

const VIDEO_EXTRA_PARAM_RESERVED_FIELDS = new Set([
  'provider',
  'model',
  'ref_image',
  'input',
  'input_tts',
  'size',
  'extra_params',
])
const VIDEO_BODY_FIELDS = new Set(VIDEO_EXTRA_PARAM_RESERVED_FIELDS)
const VIDEO_FORM_FIELDS = new Set(VIDEO_EXTRA_PARAM_RESERVED_FIELDS)
const VIDEO_FILE_FIELDS = new Set(['ref_image', 'input'])
const VIDEO_SIZES = new Set(['640x640', '640x480', '480x640'])

@Service()
export class VideoService {
  createVideo(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    return handleVideoCreate(req, res, false, parsedBody)
  }

  streamVideo(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    return handleVideoCreate(req, res, true, parsedBody)
  }

  retrieveVideo(video_id: string, provider_id: string | undefined, res: ServerResponse): Promise<void> {
    return handleVideoRetrieve(video_id, provider_id, res)
  }

  downloadVideoContent(video_id: string, provider_id: string | undefined, variant: string | undefined, res: ServerResponse): Promise<void> {
    return handleVideoContent(video_id, provider_id, variant, res)
  }
}

async function handleVideoCreate(req: IncomingMessage, res: ServerResponse, stream: boolean, parsedBody?: unknown): Promise<void> {
  const input = await readVideoCreateRequest(req, parsedBody)
  const target = resolveVideoTarget(getVideoField(input, 'model'), getVideoField(input, 'provider'))
  const providerId = target.providerId
  assertPublicProviderAccess(providerId)
  const provider = getVideoProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = normalizeVideoInput(provider.id, input, target.model)
  const timeout = getProviderTimeoutMs(context)
  if (stream) {
    if (!provider.streamVideo) throw new Error(`Provider does not support video streaming: ${provider.id}`)
    const result = await withTimeout(
      provider.streamVideo(request, context),
      timeout,
      `Video stream creation timed out after ${timeout}ms for provider ${provider.id}`,
    )
    sendStream(res, result.stream, result.mime_type, result.video_id ? { 'x-video-id': result.video_id } : {})
    return
  }

  const result = await withTimeout(
    provider.createVideo(request, context),
    timeout,
    `Video creation timed out after ${timeout}ms for provider ${provider.id}`,
  )
  sendJson(res, result)
}

async function handleVideoRetrieve(video_id: string, provider_id: string | undefined, res: ServerResponse): Promise<void> {
  const providerId = normalizeReadProviderId(provider_id)
  assertPublicProviderAccess(providerId)
  const provider = getVideoProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)
  const timeout = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.retrieveVideo(video_id, context),
    timeout,
    `Video retrieval timed out after ${timeout}ms for provider ${provider.id}`,
  )
  sendJson(res, result)
}

async function handleVideoContent(video_id: string, provider_id: string | undefined, variant: string | undefined, res: ServerResponse): Promise<void> {
  const providerId = normalizeReadProviderId(provider_id)
  assertPublicProviderAccess(providerId)
  const normalizedVariant = normalizeVideoVariant(variant)
  const provider = getVideoProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)
  const timeout = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.downloadVideoContent(video_id, normalizedVariant, context),
    timeout,
    `Video content download timed out after ${timeout}ms for provider ${provider.id}`,
  )
  sendBinary(res, result.video, result.mime_type)
}

async function readVideoCreateRequest(req: IncomingMessage, parsedBody?: unknown): Promise<Record<string, unknown> | Awaited<ReturnType<typeof readMultipartForm>>> {
  const contentType = req.headers['content-type'] ?? ''
  if (/multipart\/form-data/i.test(contentType)) {
    const form = await readMultipartForm(req)
    assertSupportedMultipartFields(form, VIDEO_FORM_FIELDS, VIDEO_FILE_FIELDS)
    return form
  }
  const body = isJsonObjectRecord(parsedBody)
    ? parsedBody
    : await readJson<Record<string, unknown>>(req)
  assertSupportedJsonFields(body, VIDEO_BODY_FIELDS)
  return body
}

function normalizeVideoInput(
  providerId: string,
  input: Record<string, unknown> | Awaited<ReturnType<typeof readMultipartForm>>,
  resolvedModel?: string,
): VideoCreateRequest {
  const request = isMultipartVideoInput(input)
    ? normalizeMultipartVideoInput(providerId, input, resolvedModel)
    : normalizeJsonVideoInput(providerId, input, resolvedModel)
  validateVideoDrivingInput(request)
  return request
}

function normalizeJsonVideoInput(providerId: string, body: Record<string, unknown>, resolvedModel?: string): VideoCreateRequest {
  const ref_image = normalizeRequiredString(body.ref_image, 'ref_image')
  const rawInput = normalizeOptionalString(body.input, 'input')
  const input_tts = normalizeJsonObjectValue(body.input_tts, 'input_tts')
  validateInputTts(input_tts)
  return {
    provider: providerId,
    model: resolvedModel,
    ref_image,
    input: rawInput,
    input_tts,
    size: normalizeVideoSize(body.size),
    extra_params: normalizeExtraParams(body.extra_params, VIDEO_EXTRA_PARAM_RESERVED_FIELDS),
  }
}

function normalizeMultipartVideoInput(
  providerId: string,
  form: Awaited<ReturnType<typeof readMultipartForm>>,
  resolvedModel?: string,
): VideoCreateRequest {
  const ref_image = getMultipartVideoSource(form, 'ref_image')
  if (!ref_image) throw new Error('ref_image is required')
  const input = getMultipartVideoSource(form, 'input')
  const input_tts = form.fields.input_tts ? parseJsonObjectField(form.fields.input_tts, 'input_tts') : undefined
  validateInputTts(input_tts)
  return {
    provider: providerId,
    model: resolvedModel,
    ref_image,
    input,
    input_tts,
    size: normalizeVideoSize(form.fields.size),
    extra_params: normalizeExtraParams(
      form.fields.extra_params ? parseJsonObjectField(form.fields.extra_params, 'extra_params') : undefined,
      VIDEO_EXTRA_PARAM_RESERVED_FIELDS,
    ),
  }
}

function getMultipartVideoSource(
  form: Awaited<ReturnType<typeof readMultipartForm>>,
  field: 'ref_image' | 'input',
): string | ProviderFile | undefined {
  const file = form.files[field]
  if (file) {
    return {
      data: file.data,
      mime_type: normalizeMimeType(file.content_type),
      file_name: file.file_name,
    }
  }
  return normalizeOptionalString(form.fields[field], field)
}

function validateVideoDrivingInput(request: VideoCreateRequest): void {
  const hasInput = Boolean(request.input)
  const hasInputTts = Boolean(request.input_tts)
  if (hasInput === hasInputTts) throw new Error('Provide exactly one of input or input_tts')
}

function validateInputTts(value: JsonObject | undefined): void {
  if (!value) return
  if ('stream' in value) throw new Error('input_tts.stream is not supported')
}

function resolveVideoTarget(model: unknown, provider: unknown): { providerId: string, model?: string } {
  const modelId = typeof model === 'string' ? model.trim() : ''
  const explicitProvider = typeof provider === 'string' ? provider.trim() : ''
  if (explicitProvider) {
    return { providerId: explicitProvider, model: modelId || undefined }
  }
  if (modelId && hasVideoProvider(modelId)) {
    return { providerId: modelId }
  }
  if (modelId) {
    const providerByModel = findProviderByModelOption(modelId, listVideoProviders(), 'video_model')
    if (providerByModel) return { providerId: providerByModel, model: modelId }
  }
  return { providerId: 'boson', model: modelId || undefined }
}

function normalizeReadProviderId(provider_id: string | undefined): string {
  const providerId = provider_id?.trim()
  if (providerId) return providerId
  return 'boson'
}

function normalizeVideoVariant(value: string | undefined): 'video' | undefined {
  const variant = value?.trim()
  if (!variant) return undefined
  if (variant === 'video') return 'video'
  throw new Error('variant must be "video"')
}

function getVideoField(input: Record<string, unknown> | Awaited<ReturnType<typeof readMultipartForm>>, field: 'model' | 'provider'): unknown {
  return isMultipartVideoInput(input) ? input.fields[field] : input[field]
}

function isMultipartVideoInput(value: Record<string, unknown> | Awaited<ReturnType<typeof readMultipartForm>>): value is Awaited<ReturnType<typeof readMultipartForm>> {
  return 'fields' in value && 'files' in value && 'field_arrays' in value
}

function isJsonObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertSupportedMultipartFields(
  form: Awaited<ReturnType<typeof readMultipartForm>>,
  allowed_fields: ReadonlySet<string>,
  allowed_files: ReadonlySet<string>,
): void {
  const unsupported_field = Object.keys(form.fields).find(field => !allowed_fields.has(field))
  if (unsupported_field) throw new Error(`${unsupported_field} is not supported`)
  const unsupported_file = Object.keys(form.files).find(field => !allowed_files.has(field))
  if (unsupported_file) throw new Error(`${unsupported_file} is not supported`)
}

function assertSupportedJsonFields(body: Record<string, unknown>, allowed_fields: ReadonlySet<string>): void {
  const unsupported_field = Object.keys(body).find(field => !allowed_fields.has(field))
  if (unsupported_field) throw new Error(`${unsupported_field} is not supported`)
}

function normalizeVideoSize(value: unknown): VideoCreateRequest['size'] {
  const size = normalizeOptionalString(value, 'size')
  if (!size) return undefined
  if (VIDEO_SIZES.has(size)) return size as VideoCreateRequest['size']
  throw new Error('size must be one of "640x640", "640x480", or "480x640"')
}

function normalizeRequiredString(value: unknown, field_name: string): string {
  const text = normalizeOptionalString(value, field_name)
  if (!text) throw new Error(`${field_name} is required`)
  return text
}

function normalizeOptionalString(value: unknown, field_name: string): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${field_name} must be a string`)
  return value.trim() || undefined
}

function normalizeJsonObjectValue(value: unknown, field_name: string): JsonObject | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new Error(`${field_name} must be a JSON object`)
  }
  return value as JsonObject
}

function normalizeExtraParams(value: unknown, reserved_fields?: ReadonlySet<string>): JsonObject | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new Error('extra_params must be a JSON object')
  }
  const extra_params = value as JsonObject
  const conflict = Object.keys(extra_params).find(key => reserved_fields?.has(key))
  if (conflict) throw new Error(`extra_params.${conflict} conflicts with a recognized request field`)
  return extra_params
}

function parseJsonObjectField(value: string, fieldName: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !isJsonValue(parsed)) {
      throw new Error(`${fieldName} must be a JSON object`)
    }
    return parsed as JsonObject
  } catch (error) {
    if (error instanceof Error && error.message === `${fieldName} must be a JSON object`) throw error
    throw new Error(`${fieldName} must be valid JSON`)
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue)
  return false
}

function findProviderByModelOption(
  modelId: string,
  providers: Array<{ id: string, fields?: Array<{ key: string, options?: string[] }> }>,
  fieldKey: string,
): string | undefined {
  const matches = providers
    .filter(provider => provider.fields?.some(field => field.key === fieldKey && field.options?.includes(modelId)))
    .map(provider => provider.id)
  return matches.length === 1 ? matches[0] : undefined
}

function hasVideoProvider(id: string): boolean {
  try {
    getVideoProvider(id)
    return true
  } catch {
    return false
  }
}

function normalizeMimeType(value: string | undefined): string {
  return value?.split(';')[0]?.trim() || 'application/octet-stream'
}
