// Import all from the folder pipelines/Graphs

import { type Node, type Edge } from "@xyflow/react";

export interface PipelineGraph {
  id: string;
  title: string;
  nodes: Node[];
  edges: Edge[];
}

export interface PipelineGraphs {
  pipelines: PipelineGraph[];
}

