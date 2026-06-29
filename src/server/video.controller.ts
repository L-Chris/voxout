import type { ServerResponse } from 'node:http'
import type { Context } from 'koa'
import { Ctx, Get, JsonController, Param, Post, QueryParam } from 'routing-controllers'
import { Service } from 'typedi'
import { VideoService } from './video.service.js'

@JsonController()
@Service()
export class VideoController {
  constructor(private readonly videos: VideoService) {}

  @Post('/v1/videos')
  async createVideo(@Ctx() ctx: Context) {
    await this.videos.createVideo(ctx.req, takeOverResponse(ctx), getParsedBody(ctx))
    return ctx
  }

  @Post('/v1/videos/stream')
  async streamVideo(@Ctx() ctx: Context) {
    await this.videos.streamVideo(ctx.req, takeOverResponse(ctx), getParsedBody(ctx))
    return ctx
  }

  @Get('/v1/videos/:video_id/content')
  async downloadVideoContent(
    @Param('video_id') video_id: string,
    @QueryParam('provider') provider_id: string,
    @QueryParam('variant') variant: string,
    @Ctx() ctx: Context,
  ) {
    await this.videos.downloadVideoContent(video_id, provider_id, variant, takeOverResponse(ctx))
    return ctx
  }

  @Get('/v1/videos/:video_id')
  async retrieveVideo(
    @Param('video_id') video_id: string,
    @QueryParam('provider') provider_id: string,
    @Ctx() ctx: Context,
  ) {
    await this.videos.retrieveVideo(video_id, provider_id, takeOverResponse(ctx))
    return ctx
  }
}

function takeOverResponse(ctx: Context): ServerResponse {
  ctx.respond = false
  return ctx.res
}

function getParsedBody(ctx: Context): unknown {
  return (ctx.request as { body?: unknown }).body
}
