import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PipelineGraph } from "../../pipeline_graphs";
import "@xyflow/react/dist/style.css";
import "./PipelineSelector.css";

type SelectablePipelineFlowProps = {
  graph: PipelineGraph;
};

type PathSelection = {
  sourceId: string;
  edgeId: string;
};

const ACTIVE_NODE_STYLE = {
  backgroundColor: "#d1fae5",
  border: "2px solid #10b981",
  color: "#111827",
  opacity: 1,
  boxShadow: "0 0 0 3px rgba(16, 185, 129, 0.16)",
};

const SELECTED_NODE_STYLE = {
  backgroundColor: "#bfdbfe",
  border: "2px solid #2563eb",
  color: "#111827",
  opacity: 1,
  boxShadow: "0 0 0 3px rgba(37, 99, 235, 0.16)",
};

const INACTIVE_NODE_STYLE = {
  backgroundColor: "#f3f4f6",
  border: "1px solid #d1d5db",
  color: "#6b7280",
  opacity: 0.16,
  boxShadow: "none",
};

function SelectablePipelineFlowInner({ graph }: SelectablePipelineFlowProps) {
  const { fitView } = useReactFlow();

  const [inputId, setInputId] = useState("FASTQ");
  const [selections, setSelections] = useState<PathSelection[]>([]);
  const [nodePositions, setNodePositions] = useState<Node[]>(graph.nodes);

  useEffect(() => {
    setNodePositions(graph.nodes);
    setInputId(graph.nodes.some((node) => node.id === "FASTQ") ? "FASTQ" : graph.nodes[0]?.id ?? "");
    setSelections([]);
  }, [graph]);

  const nodeById = useMemo(
    () => new Map(nodePositions.map((node) => [node.id, node])),
    [nodePositions],
  );

  const edgeById = useMemo(
    () => new Map(graph.edges.map((edge) => [edge.id, edge])),
    [graph.edges],
  );

  const outgoingEdges = useCallback(
    (nodeId: string) => graph.edges.filter((edge) => edge.source === nodeId),
    [graph.edges],
  );

  const activePath = useMemo(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const orderedNodeIds: string[] = [];

    if (!inputId || !nodeById.has(inputId)) {
      return { nodeIds, edgeIds, orderedNodeIds };
    }

    let currentId: string | undefined = inputId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      nodeIds.add(currentId);
      orderedNodeIds.push(currentId);

      const outgoing = outgoingEdges(currentId);
      if (outgoing.length === 0) break;

      const explicitSelection = selections.find(
        (selection) => selection.sourceId === currentId,
      );

      let selectedEdge: Edge | undefined;

      if (outgoing.length === 1) {
        selectedEdge = outgoing[0];
      } else if (explicitSelection) {
        selectedEdge = outgoing.find(
          (edge) => edge.id === explicitSelection.edgeId,
        );
      }

      if (!selectedEdge) break;

      edgeIds.add(selectedEdge.id);
      currentId = selectedEdge.target;
    }

    return { nodeIds, edgeIds, orderedNodeIds };
  }, [inputId, nodeById, outgoingEdges, selections]);

  const decisionNodes = useMemo(
    () =>
      activePath.orderedNodeIds
        .map((nodeId) => ({
          node: nodeById.get(nodeId),
          options: outgoingEdges(nodeId),
        }))
        .filter(
          (decision): decision is { node: Node; options: Edge[] } =>
            Boolean(decision.node) && decision.options.length > 1,
        ),
    [activePath.orderedNodeIds, nodeById, outgoingEdges],
  );

  const styledNodes = useMemo(
    () =>
      nodePositions.map((node) => {
        const isInput = node.id === inputId;
        const isActive = activePath.nodeIds.has(node.id);

        return {
          ...node,
          zIndex: isActive ? 100 : 0,
          data: {
            ...node.data,
            status: isActive ? "active_node" : "inactive_node",
          },
          style: {
            ...node.style,
            ...(isInput
              ? ACTIVE_NODE_STYLE
              : isActive
                ? SELECTED_NODE_STYLE
                : INACTIVE_NODE_STYLE),
          },
        };
      }),
    [activePath.nodeIds, inputId, nodePositions],
  );

  const styledEdges = useMemo(
    () =>
      graph.edges.map((edge) => {
        const isActive = activePath.edgeIds.has(edge.id);

        return {
          ...edge,
          animated: isActive,
          zIndex: isActive ? 100 : 0,
          style: {
            ...edge.style,
            stroke: isActive ? "#2563eb" : "#d1d5db",
            strokeWidth: isActive ? 3 : 1,
            opacity: isActive ? 1 : 0.12,
          },
          labelStyle: {
            ...edge.labelStyle,
            fill: isActive ? "#1d4ed8" : "#9ca3af",
            fontWeight: isActive ? 700 : 400,
            opacity: isActive ? 1 : 0.15,
          },
        };
      }),
    [activePath.edgeIds, graph.edges],
  );

  const chooseEdge = useCallback(
    (sourceId: string, edgeId: string) => {
      const selectedEdge = edgeById.get(edgeId);
      if (!selectedEdge) return;

      const downstreamIds = new Set<string>();
      const queue = [selectedEdge.target];

      while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (downstreamIds.has(currentId)) continue;

        downstreamIds.add(currentId);
        outgoingEdges(currentId).forEach((edge) => queue.push(edge.target));
      }

      setSelections((current) => [
        ...current.filter(
          (selection) =>
            selection.sourceId !== sourceId &&
            !downstreamIds.has(selection.sourceId),
        ),
        { sourceId, edgeId },
      ]);
    },
    [edgeById, outgoingEdges],
  );

  const handleInputChange = (nextInputId: string) => {
    setInputId(nextInputId);
    setSelections([]);
  };

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setNodePositions((current) => applyNodeChanges(changes, current));
  }, []);

  const focusPath = useCallback(() => {
    const activeNodes = styledNodes.filter((node) => activePath.nodeIds.has(node.id));

    if (activeNodes.length > 0) {
      void fitView({
        nodes: activeNodes,
        padding: 0.35,
        duration: 600,
        maxZoom: 1.2,
      });
    }
  }, [activePath.nodeIds, fitView, styledNodes]);

  const showFullGraph = useCallback(() => {
  void fitView({
    nodes: styledNodes,
    padding: 0.08,
    duration: 600,
    minZoom: 0.03,
    maxZoom: 0.6,
  });
}, [fitView, styledNodes]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(focusPath);
    return () => window.cancelAnimationFrame(frame);
  }, [activePath.edgeIds, focusPath]);

  const inputOptions = graph.nodes.filter(
    (node) => node.id === "FASTQ" || node.id === "POD5",
  );

  return (
    <div className="pipeline-selector">
      <div className="pipeline-selector__panel">
        <div className="pipeline-selector__field">
          <label htmlFor="pipeline-input">Input</label>
          <select
            id="pipeline-input"
            value={inputId}
            onChange={(event) => handleInputChange(event.target.value)}
          >
            {inputOptions.map((node) => (
              <option key={node.id} value={node.id}>
                {String(node.data.label ?? node.id)}
              </option>
            ))}
          </select>
        </div>

        {decisionNodes.map(({ node, options }) => {
          const selectedEdgeId =
            selections.find((selection) => selection.sourceId === node.id)?.edgeId ?? "";

          return (
            <div className="pipeline-selector__field" key={node.id}>
              <label htmlFor={`decision-${node.id}`}>
                {String(node.data.label ?? node.id)}
              </label>
              <select
                id={`decision-${node.id}`}
                value={selectedEdgeId}
                onChange={(event) => chooseEdge(node.id, event.target.value)}
              >
                <option value="" disabled>
                  Choose a branch
                </option>
                {options.map((edge) => {
                  const targetNode = nodeById.get(edge.target);
                  const targetLabel = targetNode?.data.label ?? edge.target;
                  const decisionLabel = edge.label
                    ? `${String(edge.label)} → ${String(targetLabel)}`
                    : String(targetLabel);

                  return (
                    <option key={edge.id} value={edge.id}>
                      {decisionLabel}
                    </option>
                  );
                })}
              </select>
            </div>
          );
        })}

        <div className="pipeline-selector__buttons">
  <button
    className="pipeline-selector__focus"
    type="button"
    onClick={focusPath}
  >
    Focus selected path
  </button>

  <button
    className="pipeline-selector__full"
    type="button"
    onClick={showFullGraph}
  >
    Show full graph
  </button>
</div>
      </div>

      <div className="pipeline-selector__summary">
        <strong>Selected path:</strong>{" "}
        {activePath.orderedNodeIds
          .map((nodeId) => String(nodeById.get(nodeId)?.data.label ?? nodeId))
          .join(" → ")}
      </div>

      <div className="pipeline-selector__flow">
        <ReactFlow
          nodes={styledNodes}
          edges={styledEdges}
          onNodesChange={handleNodesChange}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          panOnScroll={false}
          panOnDrag
          fitView
          minZoom={0.02}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="#e5e7eb" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <div className="pipeline-selector__legend">
        <span><i className="pipeline-selector__key pipeline-selector__key--input" />Input</span>
        <span><i className="pipeline-selector__key pipeline-selector__key--path" />Selected path</span>
        <span><i className="pipeline-selector__key pipeline-selector__key--inactive" />Other possibilities</span>
      </div>
    </div>
  );
}

export default function SelectablePipelineFlow(props: SelectablePipelineFlowProps) {
  return (
    <ReactFlowProvider>
      <SelectablePipelineFlowInner {...props} />
    </ReactFlowProvider>
  );
}
