import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export interface MultipartFile {
  file_name: string
  content_type: string
  data: Buffer
}

export interface MultipartForm {
  fields: Record<string, string>
  field_arrays: Record<string, string[]>
  files: Record<string, MultipartFile>
}

export function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS')
}

export function sendJson(res: ServerResponse, value: unknown, status = 200, headOnly = false): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(headOnly ? undefined : body)
}

export function sendError(res: ServerResponse, message: string, status = 400, headOnly = false): void {
  sendJson(res, {
    error: {
      message,
      type: getErrorType(status),
      param: null,
      code: null,
    },
  }, status, headOnly)
}

function getErrorType(status: number): string {
  if (status === 404) return 'not_found_error'
  if (status >= 500) return 'server_error'
  return 'invalid_request_error'
}

export function sendText(res: ServerResponse, value: string, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(value)),
  })
  res.end(value)
}

export function sendBinary(res: ServerResponse, value: Buffer, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(value.length),
  })
  res.end(value)
}

export function sendStream(res: ServerResponse, stream: ReadableStream<Uint8Array>, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
  })
  Readable.fromWeb(stream).on('error', error => res.destroy(error)).pipe(res)
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text || '{}') as T
}

export async function readMultipartForm(req: IncomingMessage): Promise<MultipartForm> {
  const contentType = req.headers['content-type'] ?? ''
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[1]
    ?? /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[2]
  if (!boundary) throw new Error('multipart/form-data boundary is required')
  const body = await readRequestBuffer(req)
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  const field_arrays: Record<string, string[]> = {}
  const files: Record<string, MultipartFile> = {}
  let cursor = body.indexOf(boundaryBuffer)

  while (cursor >= 0) {
    cursor += boundaryBuffer.length
    if (body[cursor] === 45 && body[cursor + 1] === 45) break
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) break
    const headers = body.slice(cursor, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
    if (nextBoundary < 0) break
    const data = body.slice(dataStart, nextBoundary)
    const disposition = /^content-disposition:\s*([^\r\n]+)/im.exec(headers)?.[1] ?? ''
    const name = /name="([^"]+)"/.exec(disposition)?.[1]
    const file_name = /filename="([^"]*)"/.exec(disposition)?.[1]
    const content_type = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? 'application/octet-stream'
    if (name && file_name != null) {
      files[name] = { file_name, content_type, data }
    } else if (name) {
      const value = data.toString('utf8')
      fields[name] = value
      const array_name = name.endsWith('[]') ? name.slice(0, -2) : name
      field_arrays[array_name] = [...(field_arrays[array_name] ?? []), value]
    }
    cursor = body.indexOf(boundaryBuffer, nextBoundary + 2)
  }
  return { fields, field_arrays, files }
}

async function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}
