import { useMemo, useState } from 'react';
import type { MemoryGraph as Graph, MemoryFact } from '../../../../shared/memory';

export function MemoryGraph({
  graph,
  onSelect,
}: {
  graph: Graph;
  onSelect: (fact: MemoryFact) => void;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const visible = useMemo(() => {
    const edges = (
      focus
        ? graph.edges.filter((edge) => edge.subjectId === focus || edge.objectId === focus)
        : graph.edges
    ).slice(0, 35);
    const ids = new Set(edges.flatMap((edge) => [edge.subjectId, edge.objectId]));
    const nodes = graph.nodes.filter((node) => ids.has(node.id)).slice(0, 36);
    const positioned = nodes.map((node, index) => {
      const angle = (index * Math.PI * 2) / Math.max(1, nodes.length) - Math.PI / 2;
      const ring = index % 2 === 0 ? 175 : 115;
      return { ...node, x: 330 + Math.cos(angle) * ring, y: 230 + Math.sin(angle) * ring };
    });
    const positions = new Map(positioned.map((node) => [node.id, node]));
    return {
      nodes: positioned,
      edges: edges.filter((edge) => positions.has(edge.subjectId) && positions.has(edge.objectId)),
      positions,
    };
  }, [graph, focus]);
  return (
    <div className="memory-graph">
      <div className="memory-graph-toolbar">
        <span>
          {focus ? 'Selected neighborhood' : 'Recent relationships'} · {visible.nodes.length}{' '}
          entities
        </span>
        <div>
          <button
            className="button button--ghost"
            onClick={() => setZoom(Math.max(0.6, zoom - 0.2))}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            className="button button--ghost"
            onClick={() => setZoom(Math.min(2, zoom + 0.2))}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className="button button--ghost"
            onClick={() => {
              setFocus(null);
              setZoom(1);
            }}
          >
            Reset
          </button>
        </div>
      </div>
      {!visible.nodes.length ? (
        <div className="memory-empty">
          Your relationships will appear here as memories are added.
        </div>
      ) : (
        <svg
          viewBox="0 0 660 460"
          role="img"
          aria-label="Memory relationship graph. Select an entity to focus, or a relationship to inspect its source."
        >
          <defs>
            <marker
              id="memory-arrow"
              viewBox="0 0 10 10"
              refX="24"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          <g transform={`translate(330 230) scale(${zoom}) translate(-330 -230)`}>
            {visible.edges.map((edge) => {
              const source = visible.positions.get(edge.subjectId)!,
                target = visible.positions.get(edge.objectId)!;
              return (
                <g
                  key={edge.id}
                  className={`memory-graph-edge ${edge.validTo ? 'is-historical' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${edge.subject} ${edge.relation} ${edge.object}`}
                  onClick={() => onSelect(edge)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(edge);
                    }
                  }}
                >
                  <title>{edge.text}</title>
                  <line
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    markerEnd="url(#memory-arrow)"
                  />
                  <line
                    className="memory-graph-hit"
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                  />
                  <text
                    x={(source.x + target.x) / 2}
                    y={(source.y + target.y) / 2 - 5}
                    textAnchor="middle"
                  >
                    {edge.relation.replace(/_/g, ' ').slice(0, 24)}
                  </text>
                </g>
              );
            })}
            {visible.nodes.map((node) => (
              <g
                key={node.id}
                className="memory-graph-node"
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={`Focus ${node.name}`}
                onClick={() => setFocus(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setFocus(node.id);
                  }
                }}
              >
                <title>
                  {node.name} · {node.type}
                  {node.ownerId ? ' · private' : ''}
                </title>
                <circle r="18" />
                <text y="4" textAnchor="middle">
                  {node.name.slice(0, 1).toUpperCase()}
                </text>
                <text className="memory-node-label" y="34" textAnchor="middle">
                  {node.name.length > 22 ? node.name.slice(0, 20) + '…' : node.name}
                </text>
              </g>
            ))}
          </g>
        </svg>
      )}
      <p className="memory-caption">
        Select a connection for evidence and history. Select an entity to focus. Dashed connections
        are historical.{' '}
        {graph.truncated || graph.edges.length > 35
          ? 'Showing a bounded view; search to narrow the graph.'
          : ''}
      </p>
    </div>
  );
}
