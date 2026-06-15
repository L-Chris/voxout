import type { Context, Next } from 'koa'
import { Middleware, type KoaMiddlewareInterface } from 'routing-controllers'
import { Service } from 'typedi'
import { sendError } from './http.js'

@Middleware({ type: 'before' })
@Service()
export class ErrorMiddleware implements KoaMiddlewareInterface {
  async use(ctx: Context, next: Next): Promise<void> {
    try {
      await next()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.respond = false
      sendError(ctx.res, message, getErrorStatus(error), ctx.method === 'HEAD')
    }
  }
}

function getErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'httpCode' in error && typeof error.httpCode === 'number') {
    return error.httpCode
  }
  return 400
}
