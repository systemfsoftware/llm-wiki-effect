import { Effect, Layer } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { Config } from '../config/Config.js'
import { ProviderClient } from './provider-client.js'
import { httpTransport } from './provider-transport.js'

export const providerClientLayer: Layer.Layer<ProviderClient, never, Config | HttpClient.HttpClient> = Layer.effect(
  ProviderClient,
  Effect.gen(function*() {
    const config = yield* Config
    return yield* ProviderClient.make({
      credentials: config.providerCredentials,
      transport: httpTransport(yield* HttpClient.HttpClient),
    })
  }),
)
