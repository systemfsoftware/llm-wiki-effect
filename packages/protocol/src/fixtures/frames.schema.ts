import { Schema } from 'effect'

export const RequestFrameEnvelopeBase = Schema.TaggedStruct('Request', {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
})

export type RequestFrameEnvelope = Schema.Schema.Type<typeof RequestFrameEnvelopeBase>

export const ChunkFrameEnvelopeBase = Schema.TaggedStruct('Chunk', {
  requestId: Schema.String,
  values: Schema.Array(Schema.Unknown),
})

export type ChunkFrameEnvelope = Schema.Schema.Type<typeof ChunkFrameEnvelopeBase>

export const ExitFrameEnvelopeBase = Schema.TaggedStruct('Exit', {
  requestId: Schema.String,
  exit: Schema.Unknown,
})

export type ExitFrameEnvelope = Schema.Schema.Type<typeof ExitFrameEnvelopeBase>

export const DefectFrameEnvelopeBase = Schema.TaggedStruct('Defect', {
  defect: Schema.Unknown,
})

export type DefectFrameEnvelope = Schema.Schema.Type<typeof DefectFrameEnvelopeBase>

export type GoldenEnvelope =
  | RequestFrameEnvelope
  | ChunkFrameEnvelope
  | ExitFrameEnvelope
  | DefectFrameEnvelope
