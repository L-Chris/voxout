import { EdgeTtsProvider } from './edge.js'
import type { ProviderContext, ProviderFieldDefinition, SynthesizeRequest, TtsProvider, TtsVoice } from '../../types.js'

export class DefaultProvider implements TtsProvider {
  readonly id = 'default'
  readonly name = 'Default'
  readonly capabilities = { tts: true, tts_streaming: true }
  readonly fields: ProviderFieldDefinition[]

  constructor(
    private readonly edge = new EdgeTtsProvider('default'),
  ) {
    this.fields = [
      ...this.edge.fields,
    ]
  }

  listVoices(context?: ProviderContext): Promise<TtsVoice[]> {
    return this.edge.listVoices(context)
  }

  synthesize(request: SynthesizeRequest, context?: ProviderContext) {
    return this.edge.synthesize(request, context)
  }

  streamSynthesize(request: SynthesizeRequest, context?: ProviderContext) {
    return this.edge.streamSynthesize(request, context)
  }
}
