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

  @Get('/api/providers/:provider_id/voices')
  listProviderVoices(@Param('provider_id') provider_id: string) {
    return this.providers.listProviderVoices(provider_id)
  }

  @Get('/v1/models')
  listModels() {
    return this.providers.listModels()
  }

  @Put('/api/providers/:provider_id/config')
  async updateProviderConfig(
    @Param('provider_id') provider_id: string,
    @Body({ required: true }) input: ProviderConfigInput,
  ) {
    return this.providers.updateProviderConfig(provider_id, input)
  }
}
