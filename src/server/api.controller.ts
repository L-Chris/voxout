import { Body, Get, JsonController, Param, Put, QueryParam } from 'routing-controllers'
import { Service } from 'typedi'
import { ProviderService } from './provider.service.js'
import type { ProviderConfigInput } from '../types.js'

@JsonController()
@Service()
export class ApiController {
  constructor(private readonly providers: ProviderService) {}

  @Get('/health')
  health() {
    return this.providers.health()
  }

  @Get('/api/providers')
  listProviders() {
    return this.providers.listProviders()
  }

  @Get('/api/voices')
  listVoices(@QueryParam('provider') provider?: string) {
    return this.providers.listVoices(provider)
  }

  @Get('/api/providers/:providerId/voices')
  listProviderVoices(@Param('providerId') providerId: string) {
    return this.providers.listProviderVoices(providerId)
  }

  @Get('/v1/models')
  listModels() {
    return this.providers.listModels()
  }

  @Put('/api/providers/:providerId/config')
  async updateProviderConfig(
    @Param('providerId') providerId: string,
    @Body({ required: true }) input: ProviderConfigInput,
  ) {
    return this.providers.updateProviderConfig(providerId, input)
  }
}
