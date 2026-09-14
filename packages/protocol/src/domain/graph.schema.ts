import { Schema } from 'effect'

export class GraphNode extends Schema.Class<GraphNode>('GraphNode')({
  id: Schema.String,
  label: Schema.String,
  nodeType: Schema.String,
  path: Schema.String,
  linkCount: Schema.Number,
}) {}

export class GraphEdge extends Schema.Class<GraphEdge>('GraphEdge')({
  source: Schema.String,
  target: Schema.String,
  weight: Schema.Number,
}) {}

export class GraphResponse extends Schema.Class<GraphResponse>('GraphResponse')({
  projectId: Schema.String,
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
}) {}
