import type {
  ChunkFrameEnvelope,
  DefectFrameEnvelope,
  ExitFrameEnvelope,
  GoldenEnvelope,
  RequestFrameEnvelope,
} from './frames.schema.js'

export type { ChunkFrameEnvelope, DefectFrameEnvelope, ExitFrameEnvelope, GoldenEnvelope, RequestFrameEnvelope }

export type GoldenFrame<E extends GoldenEnvelope = GoldenEnvelope> = {
  readonly name: string
  readonly file: string
  readonly bytes: string
  readonly envelope: E
}

export const GoldenFrames: Readonly<{
  request: GoldenFrame<RequestFrameEnvelope>
  embedTexts: GoldenFrame<RequestFrameEnvelope>
  voidRequest: GoldenFrame<RequestFrameEnvelope>
  chunk: GoldenFrame<ChunkFrameEnvelope>
  exit: GoldenFrame<ExitFrameEnvelope>
  defect: GoldenFrame<DefectFrameEnvelope>
}> = {
  request: {
    name: 'request',
    file: 'request.ndjson',
    bytes:
      '{"_tag":"Request","id":"1","tag":"search","payload":{"projectId":"current","query":"attention","topK":10},"headers":[]}\n',
    envelope: {
      _tag: 'Request',
      id: '1',
      tag: 'search',
      payload: { projectId: 'current', query: 'attention', topK: 10 },
      headers: [],
    },
  },
  embedTexts: {
    name: 'embedTexts',
    file: 'embed-texts.ndjson',
    bytes:
      '{"_tag":"Request","id":"3","tag":"embedTexts","payload":{"provider":"openai","texts":["alpha","beta"]},"headers":[]}\n',
    envelope: {
      _tag: 'Request',
      id: '3',
      tag: 'embedTexts',
      payload: { provider: 'openai', texts: ['alpha', 'beta'] },
      headers: [],
    },
  },
  voidRequest: {
    name: 'voidRequest',
    file: 'void-request.ndjson',
    bytes: '{"_tag":"Request","id":"7","tag":"health","payload":null,"headers":[]}\n',
    envelope: {
      _tag: 'Request',
      id: '7',
      tag: 'health',
      payload: null,
      headers: [],
    },
  },
  chunk: {
    name: 'chunk',
    file: 'chunk.ndjson',
    bytes:
      '{"_tag":"Chunk","requestId":"2","values":[{"type":"meta","projectId":"p1","sessionId":"api_1","runId":"run_1"}]}\n',
    envelope: {
      _tag: 'Chunk',
      requestId: '2',
      values: [{ type: 'meta', projectId: 'p1', sessionId: 'api_1', runId: 'run_1' }],
    },
  },
  exit: {
    name: 'exit',
    file: 'exit.ndjson',
    bytes:
      '{"_tag":"Exit","requestId":"2","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"ChatCancelled","message":"Agent turn cancelled"}}]}}\n',
    envelope: {
      _tag: 'Exit',
      requestId: '2',
      exit: {
        _tag: 'Failure',
        cause: [
          { _tag: 'Fail', error: { _tag: 'ChatCancelled', message: 'Agent turn cancelled' } },
        ],
      },
    },
  },
  defect: {
    name: 'defect',
    file: 'defect.ndjson',
    bytes: '{"_tag":"Defect","defect":{"name":"Error","message":"stream interrupted"}}\n',
    envelope: { _tag: 'Defect', defect: { name: 'Error', message: 'stream interrupted' } },
  },
}

export const goldenFrames: ReadonlyArray<GoldenFrame> = [
  GoldenFrames.request,
  GoldenFrames.embedTexts,
  GoldenFrames.voidRequest,
  GoldenFrames.chunk,
  GoldenFrames.exit,
  GoldenFrames.defect,
]
