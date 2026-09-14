import { Layer } from 'effect'
import { Config } from '../config/Config.js'
import { Auth } from './auth.js'
import { Gate } from './gate.js'

export * from './auth.js'
export * from './constant-time.js'
export * from './cors.js'
export * from './gate.js'
export * from './limits.js'
export * from './requirements.js'

export const middlewareLayer = <E, R>(
  configLayer: Layer.Layer<Config, E, R>,
): Layer.Layer<Auth | Gate, E, R> => Layer.mergeAll(Auth.layer, Gate.layer).pipe(Layer.provide(configLayer))
