import type { ServerResponse } from 'node:http'
import type { Context } from 'koa'
import { Body, Ctx, Get, Head, JsonController, Param, Post } from 'routing-controllers'
import { Service } from 'typedi'
import { AudioService } from './audio.service.js'

@JsonController()
@Service()
export class AudioController {
  constructor(private readonly audio: AudioService) {}

  @Post('/v1/audio/speech')
  async createSpeech(@Body({ required: true }) body: Record<string, unknown>, @Ctx() ctx: Context) {
    await this.audio.createSpeech(body, takeOverResponse(ctx))
    return ctx
  }

  @Post('/v1/audio/effect')
  async createEffect(@Body({ required: true }) body: Record<string, unknown>, @Ctx() ctx: Context) {
    await this.audio.createEffect(body, takeOverResponse(ctx))
    return ctx
  }

  @Post('/v1/audio/isolation')
  async createIsolation(@Ctx() ctx: Context) {
    await this.audio.createIsolation(ctx.req, takeOverResponse(ctx))
    return ctx
  }

  @Post('/v1/audio/voices/design')
  async createVoiceDesign(@Body({ required: true }) body: Record<string, unknown>, @Ctx() ctx: Context) {
    await this.audio.createVoiceDesign(body, takeOverResponse(ctx))
    return ctx
  }

  @Post('/v1/audio/voices/create')
  async createDesignedVoice(@Body({ required: true }) body: Record<string, unknown>, @Ctx() ctx: Context) {
    await this.audio.createDesignedVoice(body, takeOverResponse(ctx))
    return ctx
  }

  @Post('/v1/audio/voices')
  async createVoice(@Ctx() ctx: Context) {
    await this.audio.createVoice(ctx.req, takeOverResponse(ctx))
    return ctx
  }

  @Post('/v1/audio/transcriptions')
  async transcribe(@Ctx() ctx: Context) {
    await this.audio.transcribe(ctx.req, takeOverResponse(ctx))
    return ctx
  }

  @Get('/audio/:file_name')
  async getAudio(@Param('file_name') file_name: string, @Ctx() ctx: Context) {
    await this.audio.sendAudio(takeOverResponse(ctx), file_name)
    return ctx
  }

  @Head('/audio/:file_name')
  async headAudio(@Param('file_name') file_name: string, @Ctx() ctx: Context) {
    await this.audio.sendAudio(takeOverResponse(ctx), file_name, true)
    return ctx
  }
}

function takeOverResponse(ctx: Context): ServerResponse {
  ctx.respond = false
  return ctx.res
}
