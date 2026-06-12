import 'reflect-metadata'
import Koa from 'koa'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useContainer, useKoaServer } from 'routing-controllers'
import { Container } from 'typedi'
import { loadDotEnv } from './env.js'
import { sendPublicFile } from './public.js'
import { ApiController } from './server/api.controller.js'
import { AudioController } from './server/audio.controller.js'
import { AudioService } from './server/audio.service.js'
import { ErrorMiddleware } from './server/error.middleware.js'
import { sendJson, setCorsHeaders } from './server/http.js'

const rootDir = fileURLToPath(new URL('..', import.meta.url))

await loadDotEnv([
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.local'),
  join(rootDir, '.env'),
  join(rootDir, '.env.local'),
])

const port = Number(process.env.PORT ?? 4177)
const publicDir = join(rootDir, 'public')

useContainer(Container)

const app = new Koa()

app.use(async (ctx, next) => {
  setCorsHeaders(ctx.res)
  if (ctx.method === 'OPTIONS') {
    ctx.status = 204
    return
  }
  await next()
})

app.use(async (ctx, next) => {
  if ((ctx.method === 'GET' || ctx.method === 'HEAD') && await sendPublicFile(ctx.res, publicDir, ctx.path, ctx.method === 'HEAD')) {
    ctx.respond = false
    return
  }
  await next()
})

useKoaServer(app, {
  controllers: [ApiController, AudioController],
  middlewares: [ErrorMiddleware],
  defaultErrorHandler: false,
  validation: false,
  classTransformer: false,
})

app.use(ctx => {
  if (ctx.respond === false || ctx.body !== undefined || ctx.status !== 404) return
  ctx.respond = false
  sendJson(ctx.res, { error: 'Not found' }, 404, ctx.method === 'HEAD')
})

await Container.get(AudioService).initialize()

app.listen(port, () => {
  console.log(`voxout listening on http://127.0.0.1:${port}`)
})
